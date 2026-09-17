//! The parts of a browser tab only AppKit can do: page dialogs as window
//! sheets, history without a script round trip, and app shortcuts pressed while
//! the page owns the keyboard. Everything here runs on the main thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSBitmapImageFileType, NSBitmapImageRep, NSEvent,
    NSEventMask, NSEventModifierFlags, NSImage, NSImageCompressionFactor, NSModalResponse,
    NSTextField, NSView,
};
use objc2_foundation::{
    NSData, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize,
    NSString,
};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKOpenPanelParameters,
    WKPermissionDecision, WKSecurityOrigin, WKSnapshotConfiguration, WKUIDelegate, WKWebView,
    WKWebViewConfiguration, WKWindowFeatures,
};
use tauri::{AppHandle, Emitter};

use super::{BrowserShortcut, BROWSER_SHORTCUT_EVENT};

struct NativeTab {
    agent_id: String,
    webview: Retained<WKWebView>,
    _delegate: Retained<TabUiDelegate>,
}

thread_local! {
    static TABS: RefCell<HashMap<String, NativeTab>> = RefCell::new(HashMap::new());
    static SHORTCUT_MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

fn webview_from(pointer: *mut c_void) -> Option<Retained<WKWebView>> {
    unsafe { Retained::retain(pointer.cast::<WKWebView>()) }
}

/// Take over the tab's UI delegate so page dialogs get a sheet, and remember
/// the view so shortcuts can tell which tab has focus.
pub fn adopt(pointer: *mut c_void, app: AppHandle, agent_id: String, tab_id: String) {
    let (Some(webview), Some(mtm)) = (webview_from(pointer), MainThreadMarker::new()) else {
        return;
    };
    let inner = unsafe { webview.UIDelegate() };
    let delegate = TabUiDelegate::new(mtm, inner);
    unsafe {
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        webview.setAllowsBackForwardNavigationGestures(true);
        webview.setAllowsMagnification(true);
    }
    let _ = app;
    TABS.with(|tabs| {
        tabs.borrow_mut().insert(
            tab_id,
            NativeTab {
                agent_id,
                webview,
                _delegate: delegate,
            },
        );
    });
}

pub fn forget(tab_id: &str) {
    TABS.with(|tabs| {
        tabs.borrow_mut().remove(tab_id);
    });
}

pub fn history(pointer: *mut c_void, delta: i32) {
    let Some(webview) = webview_from(pointer) else {
        return;
    };
    unsafe {
        if delta < 0 {
            webview.goBack();
        } else {
            webview.goForward();
        }
    }
}

pub fn history_state(pointer: *mut c_void) -> (bool, bool) {
    webview_from(pointer)
        .map(|webview| unsafe { (webview.canGoBack(), webview.canGoForward()) })
        .unwrap_or((false, false))
}

/// The visible page as a JPEG at 1x: plenty for a model to read at a fraction
/// of the bytes of a Retina PNG.
pub fn snapshot_jpeg(pointer: *mut c_void, done: Box<dyn FnOnce(Result<Vec<u8>, String>) + Send>) {
    let (Some(webview), Some(mtm)) = (webview_from(pointer), MainThreadMarker::new()) else {
        done(Err("the tab is gone".into()));
        return;
    };
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    let scale = webview
        .window()
        .map(|window| window.backingScaleFactor())
        .unwrap_or(1.0)
        .max(1.0);
    let width = (webview.frame().size.width / scale).max(1.0);
    unsafe {
        configuration.setSnapshotWidth(Some(&NSNumber::numberWithDouble(width)));
        configuration.setAfterScreenUpdates(true);
    }
    let done = std::sync::Mutex::new(Some(done));
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(done) = done.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let image = unsafe { Retained::retain(image) };
        let Some(image) = image else {
            done(Err(unsafe { Retained::retain(error) }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "the page could not be captured".into())));
            return;
        };
        let Some(pixels) = image.TIFFRepresentation().map(|tiff| tiff.to_vec()) else {
            done(Err("could not encode the page image".into()));
            return;
        };
        // Compressing the picture takes milliseconds, and this block runs on
        // the thread that draws every window.
        std::thread::spawn(move || {
            done(jpeg_bytes(&pixels).ok_or_else(|| "could not encode the page image".to_string()));
        });
    });
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block)
    };
}

fn jpeg_bytes(image: &[u8]) -> Option<Vec<u8>> {
    let bitmap = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(image))?;
    let quality = NSNumber::numberWithDouble(0.82);
    let properties: Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[&*quality]);
    let jpeg = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
    }?;
    Some(jpeg.to_vec())
}

struct TabUiDelegateIvars {
    inner: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TabUiDelegateIvars]
    struct TabUiDelegate;

    unsafe impl NSObjectProtocol for TabUiDelegate {}

    unsafe impl WKUIDelegate for TabUiDelegate {
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn alert(
            &self,
            webview: &WKWebView,
            message: &NSString,
            frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let done = handler.copy();
            present_sheet(
                webview,
                frame,
                &message.to_string(),
                Sheet::Alert,
                move |_, _| {
                    done.call(());
                },
            );
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn confirm(
            &self,
            webview: &WKWebView,
            message: &NSString,
            frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn(Bool)>,
        ) {
            let done = handler.copy();
            present_sheet(
                webview,
                frame,
                &message.to_string(),
                Sheet::Confirm,
                move |accepted, _| {
                    done.call((Bool::new(accepted),));
                },
            );
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        unsafe fn prompt(
            &self,
            webview: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn(*mut NSString)>,
        ) {
            let done = handler.copy();
            let default = default_text
                .map(|text| text.to_string())
                .unwrap_or_default();
            present_sheet(
                webview,
                frame,
                &prompt.to_string(),
                Sheet::Prompt(default),
                move |accepted, text| {
                    if accepted {
                        let answer = NSString::from_str(&text);
                        done.call((Retained::as_ptr(&answer) as *mut NSString,));
                    } else {
                        done.call((std::ptr::null_mut(),));
                    }
                },
            );
        }

        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        unsafe fn media_capture(
            &self,
            _webview: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            _kind: WKMediaCaptureType,
            decision: &block2::DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            decision.call((WKPermissionDecision::Grant,));
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        unsafe fn open_panel(
            &self,
            webview: &WKWebView,
            parameters: &WKOpenPanelParameters,
            frame: &WKFrameInfo,
            handler: &block2::DynBlock<
                dyn Fn(*const objc2_foundation::NSArray<objc2_foundation::NSURL>),
            >,
        ) {
            match &self.ivars().inner {
                Some(inner) => {
                    let _: () = msg_send![
                        &**inner,
                        webView: webview,
                        runOpenPanelWithParameters: parameters,
                        initiatedByFrame: frame,
                        completionHandler: handler
                    ];
                }
                None => handler.call((std::ptr::null(),)),
            }
        }

        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        unsafe fn create_web_view(
            &self,
            webview: &WKWebView,
            configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            match self.ivars().inner.as_ref() {
                Some(inner) => msg_send![
                    &**inner,
                    webView: webview,
                    createWebViewWithConfiguration: configuration,
                    forNavigationAction: action,
                    windowFeatures: features
                ],
                None => None,
            }
        }
    }
);

impl TabUiDelegate {
    fn new(
        mtm: MainThreadMarker,
        inner: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
    ) -> Retained<Self> {
        let delegate = mtm
            .alloc::<TabUiDelegate>()
            .set_ivars(TabUiDelegateIvars { inner });
        unsafe { msg_send![super(delegate), init] }
    }
}

enum Sheet {
    Alert,
    Confirm,
    Prompt(String),
}

/// A page dialog as a sheet on the app window, the way Safari shows them. The
/// page waits on `answer`, so every path must call it exactly once.
fn present_sheet(
    webview: &WKWebView,
    frame: &WKFrameInfo,
    message: &str,
    sheet: Sheet,
    answer: impl Fn(bool, String) + 'static,
) {
    let (Some(window), Some(mtm)) = (webview.window(), MainThreadMarker::new()) else {
        answer(false, String::new());
        return;
    };
    let host = unsafe { frame.securityOrigin().host().to_string() };
    let alert = NSAlert::new(mtm);
    let title = if host.is_empty() {
        "This page says".to_owned()
    } else {
        format!("{host} says")
    };
    alert.setMessageText(&NSString::from_str(&title));
    alert.setInformativeText(&NSString::from_str(message));
    alert.addButtonWithTitle(&NSString::from_str("OK"));
    if !matches!(sheet, Sheet::Alert) {
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));
    }
    let field = match &sheet {
        Sheet::Prompt(default) => {
            let field = NSTextField::initWithFrame(
                mtm.alloc::<NSTextField>(),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)),
            );
            field.setStringValue(&NSString::from_str(default));
            alert.setAccessoryView(Some(&field));
            let _ = window.makeFirstResponder(Some(&field));
            Some(field)
        }
        _ => None,
    };
    let kept = alert.clone();
    let block = RcBlock::new(move |response: NSModalResponse| {
        let _ = &kept;
        let accepted = response == NSAlertFirstButtonReturn;
        let text = field
            .as_ref()
            .map(|field| field.stringValue().to_string())
            .unwrap_or_default();
        answer(accepted, text);
    });
    alert.beginSheetModalForWindow_completionHandler(&window, Some(&block));
}

/// Command chords are the app's, not the page's, apart from the editing set
/// every text field expects to keep.
fn forwards_chord(key: &str, flags: NSEventModifierFlags) -> bool {
    if flags.contains(NSEventModifierFlags::Control) || flags.contains(NSEventModifierFlags::Option)
    {
        return false;
    }
    let mut chars = key.chars();
    let (Some(char), None) = (chars.next(), chars.next()) else {
        return false;
    };
    if !char.is_ascii_graphic() {
        return false;
    }
    !matches!(char.to_ascii_lowercase(), 'a' | 'c' | 'v' | 'x' | 'z' | 'y')
}

fn dom_code(key_code: u16, key: &str) -> String {
    let named = match key_code {
        36 => "Enter",
        48 => "Tab",
        49 => "Space",
        51 => "Backspace",
        53 => "Escape",
        123 => "ArrowLeft",
        124 => "ArrowRight",
        125 => "ArrowDown",
        126 => "ArrowUp",
        _ => "",
    };
    if !named.is_empty() {
        return named.into();
    }
    let Some(char) = key.chars().next() else {
        return String::new();
    };
    match char {
        'a'..='z' | 'A'..='Z' => format!("Key{}", char.to_ascii_uppercase()),
        '0'..='9' => format!("Digit{char}"),
        '[' => "BracketLeft".into(),
        ']' => "BracketRight".into(),
        ',' => "Comma".into(),
        '.' => "Period".into(),
        '/' => "Slash".into(),
        ';' => "Semicolon".into(),
        '\'' => "Quote".into(),
        '-' => "Minus".into(),
        '=' => "Equal".into(),
        '`' => "Backquote".into(),
        '\\' => "Backslash".into(),
        _ => String::new(),
    }
}

/// Tab under the key window's first responder, if any.
fn focused_tab(event: &NSEvent, mtm: MainThreadMarker) -> Option<(String, String)> {
    let window = event.window(mtm)?;
    let responder = window.firstResponder()?;
    let view = responder.downcast_ref::<NSView>()?;
    TABS.with(|tabs| {
        tabs.borrow()
            .iter()
            .find(|(_, tab)| view.isDescendantOf(&tab.webview))
            .map(|(id, tab)| (id.clone(), tab.agent_id.clone()))
    })
}

pub fn install_shortcuts(app: AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let pass = event.as_ptr();
        let event = unsafe { event.as_ref() };
        let flags = event.modifierFlags();
        if !flags.contains(NSEventModifierFlags::Command) {
            return pass;
        }
        let key = event
            .charactersIgnoringModifiers()
            .map(|chars| chars.to_string())
            .unwrap_or_default();
        if !forwards_chord(&key, flags) {
            return pass;
        }
        let Some((tab_id, agent_id)) = focused_tab(event, mtm) else {
            return pass;
        };
        let _ = app.emit(
            BROWSER_SHORTCUT_EVENT,
            BrowserShortcut {
                agent_id,
                tab_id,
                code: dom_code(event.keyCode(), &key),
                key,
                shift: flags.contains(NSEventModifierFlags::Shift),
                alt: false,
            },
        );
        std::ptr::null_mut()
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    SHORTCUT_MONITOR.with(|slot| *slot.borrow_mut() = monitor);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_chords_forward_and_editing_chords_stay_with_the_page() {
        let plain = NSEventModifierFlags::Command;
        assert!(forwards_chord("t", plain));
        assert!(forwards_chord("[", plain));
        assert!(forwards_chord("1", plain));
        assert!(!forwards_chord("c", plain));
        assert!(!forwards_chord("Z", plain | NSEventModifierFlags::Shift));
        assert!(!forwards_chord("t", plain | NSEventModifierFlags::Option));
        assert!(!forwards_chord("", plain));
        assert!(!forwards_chord("\u{F729}", plain));
    }

    #[test]
    fn key_codes_become_dom_codes_the_keymap_matches_on() {
        assert_eq!(dom_code(17, "t"), "KeyT");
        assert_eq!(dom_code(18, "1"), "Digit1");
        assert_eq!(dom_code(33, "["), "BracketLeft");
        assert_eq!(dom_code(36, "\r"), "Enter");
        assert_eq!(dom_code(99, "\u{F704}"), "");
    }

    /// One red pixel, the smallest picture AppKit will decode.
    const PIXEL: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn a_page_image_is_encoded_away_from_the_main_thread() {
        let encoded = std::thread::spawn(|| jpeg_bytes(PIXEL))
            .join()
            .expect("the encoder thread finished")
            .expect("the picture is encoded");
        assert_eq!(&encoded[..2], &[0xff, 0xd8], "that is not a JPEG");
        assert_eq!(
            std::thread::spawn(|| jpeg_bytes(b"not a picture"))
                .join()
                .expect("the encoder thread finished"),
            None
        );
    }
}

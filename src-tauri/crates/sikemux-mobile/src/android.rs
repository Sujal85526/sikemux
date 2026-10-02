//! Android gives a library its Java VM once, when it loads the library. Rust
//! code cannot find the app's context on its own, and three of iroh's parts
//! need it: its DNS resolver, its network watcher and the certificate check
//! behind its relays. Without it they panic the first time they run. Their
//! warnings go to logcat under the tag `sikemux`.

use std::ffi::c_void;

use jni::sys::{jint, JNI_VERSION_1_6};
use jni::{jni_sig, jni_str, Env, JavaVM};

fn hand_over(env: &mut Env) -> jni::errors::Result<()> {
    let app = env
        .call_static_method(
            jni_str!("android/app/ActivityThread"),
            jni_str!("currentApplication"),
            jni_sig!("()Landroid/app/Application;"),
            &[],
        )?
        .l()?;
    if app.is_null() {
        return Ok(());
    }
    let context = env.new_global_ref(&app)?;
    // SAFETY: both pointers stay valid for the life of the process: the VM is
    // the one running this app, and the global reference is never dropped.
    unsafe {
        ndk_context::initialize_android_context(
            env.get_java_vm()?.get_raw().cast(),
            context.as_raw().cast(),
        );
    }
    std::mem::forget(context);
    rustls_platform_verifier::android::init_with_env(env, app)
}

/// Raise the level to see why a connection stalls: iroh traces each path it tries.
fn log_to_logcat() {
    use tracing_subscriber::filter::{LevelFilter, Targets};
    use tracing_subscriber::layer::SubscriberExt;
    let filter = Targets::new().with_default(LevelFilter::WARN);
    let subscriber = tracing_subscriber::registry()
        .with(paranoid_android::layer("sikemux"))
        .with(filter);
    let _ = tracing::subscriber::set_global_default(subscriber);
}

#[unsafe(no_mangle)]
pub extern "system" fn JNI_OnLoad(vm: *mut jni::sys::JavaVM, _reserved: *mut c_void) -> jint {
    // SAFETY: Android passes the VM that is loading this library.
    let vm = unsafe { JavaVM::from_raw(vm) };
    log_to_logcat();
    let _ = vm.attach_current_thread(hand_over);
    JNI_VERSION_1_6
}

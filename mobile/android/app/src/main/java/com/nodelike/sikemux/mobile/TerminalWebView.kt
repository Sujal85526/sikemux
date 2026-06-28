package com.nodelike.sikemux.mobile

import android.annotation.SuppressLint
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.flow.SharedFlow

class TerminalBridge(private val onInput: (String) -> Unit) {
    @JavascriptInterface
    fun onInput(data: String) {
        onInput(data)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalWebView(
    events: SharedFlow<TerminalEvent>,
    onInput: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    var ready by remember { mutableStateOf(false) }
    val pending = remember { mutableStateListOf<TerminalEvent>() }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = true
                settings.mediaPlaybackRequiresUserGesture = false
                addJavascriptInterface(TerminalBridge(onInput), "SikemuxTerminal")
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        ready = true
                    }
                }
                loadUrl("file:///android_asset/terminal.html")
                webView = this
            }
        },
    )

    LaunchedEffect(events, webView) {
        events.collect { event ->
            val view = webView
            if (ready && view != null) dispatchTerminalEvent(view, event) else pending.add(event)
        }
    }

    LaunchedEffect(ready, webView) {
        val view = webView ?: return@LaunchedEffect
        if (!ready) return@LaunchedEffect
        pending.forEach { dispatchTerminalEvent(view, it) }
        pending.clear()
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.removeJavascriptInterface("SikemuxTerminal")
            webView?.destroy()
            webView = null
        }
    }
}

private fun dispatchTerminalEvent(view: WebView, event: TerminalEvent) {
    when (event) {
        is TerminalEvent.Reset -> view.evaluateJavascript(
            "window.sikemuxResetAndWrite('${event.bytes.toB64()}')",
            null,
        )
        is TerminalEvent.Append -> view.evaluateJavascript(
            "window.sikemuxWrite('${event.bytes.toB64()}')",
            null,
        )
    }
}

private fun ByteArray.toB64(): String = Base64.encodeToString(this, Base64.NO_WRAP)

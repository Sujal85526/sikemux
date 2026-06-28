package com.nodelike.sikemux.mobile

import android.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

interface SikemuxClientListener {
    fun onConnected()
    fun onDisconnected(reason: String?)
    fun onError(message: String)
    fun onSnapshot(snapshot: WorkspaceSnapshot)
    fun onPtys(ptys: List<MobilePtyInfo>)
    fun onPtySpawned(ptyId: Int)
    fun onPtySnapshot(ptyId: Int, bytes: ByteArray)
    fun onPtyOutput(ptyId: Int, bytes: ByteArray, eof: Boolean)
    fun onAck(ok: Boolean, message: String?)
}

class SikemuxClient(private val json: Json = Json { ignoreUnknownKeys = true }) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var listener: SikemuxClientListener? = null

    fun connect(rawHost: String, token: String, listener: SikemuxClientListener) {
        close()
        this.listener = listener
        val wsUrl = toWsUrl(rawHost)
        val request = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer $token")
            .build()
        socket = client.newWebSocket(request, WsListener())
    }

    fun close() {
        socket?.close(1000, "closing")
        socket = null
    }

    fun sendPing() = send(mapOf("type" to "ping"))

    fun listPtys() = send(mapOf("type" to "pty.list"))

    fun spawnPty(cwd: String, cols: Int = 80, rows: Int = 24, startup: String? = null) {
        val payload = linkedMapOf<String, Any?>(
            "type" to "pty.spawn",
            "cwd" to cwd,
            "cols" to cols,
            "rows" to rows,
            "startup" to startup,
        )
        send(payload)
    }

    fun attachPty(ptyId: Int) = send(mapOf("type" to "pty.attach", "ptyId" to ptyId))

    fun detachPty() = send(mapOf("type" to "pty.detach"))

    fun resizePty(ptyId: Int, cols: Int, rows: Int) = send(
        mapOf("type" to "pty.resize", "ptyId" to ptyId, "cols" to cols, "rows" to rows),
    )

    fun writePty(ptyId: Int, data: String, clientMsgId: String = System.nanoTime().toString()) = send(
        mapOf("type" to "pty.write", "ptyId" to ptyId, "data" to data, "clientMsgId" to clientMsgId),
    )

    private fun send(values: Map<String, Any?>) {
        val jsonText = buildString {
            append('{')
            values.entries.forEachIndexed { idx, (key, value) ->
                if (idx > 0) append(',')
                append('"').append(escape(key)).append('"').append(':')
                append(toJsonValue(value))
            }
            append('}')
        }
        socket?.send(jsonText)
    }

    private fun toJsonValue(value: Any?): String = when (value) {
        null -> "null"
        is Number, is Boolean -> value.toString()
        else -> "\"${escape(value.toString())}\""
    }

    private fun escape(value: String): String = buildString(value.length + 8) {
        value.forEach { ch ->
            when (ch) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                else -> if (ch.code < 0x20) append("\\u%04x".format(ch.code)) else append(ch)
            }
        }
    }

    private fun toWsUrl(rawHost: String): String {
        val trimmed = rawHost.trim().removeSuffix("/")
        return when {
            trimmed.startsWith("ws://") || trimmed.startsWith("wss://") -> {
                if (trimmed.endsWith("/ws")) trimmed else "$trimmed/ws"
            }
            trimmed.startsWith("http://") -> trimmed.replaceFirst("http://", "ws://").let { if (it.endsWith("/ws")) it else "$it/ws" }
            trimmed.startsWith("https://") -> trimmed.replaceFirst("https://", "wss://").let { if (it.endsWith("/ws")) it else "$it/ws" }
            else -> "ws://$trimmed/ws"
        }
    }

    private inner class WsListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            listener?.onConnected()
            listPtys()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleMessage(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
            listener?.onDisconnected(reason.ifBlank { null })
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            listener?.onDisconnected(reason.ifBlank { null })
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            listener?.onDisconnected(t.message)
        }
    }

    private fun handleMessage(text: String) {
        try {
            val root = json.parseToJsonElement(text).jsonObject
            when (root["type"]?.jsonPrimitive?.contentOrNull) {
                "hello", "heartbeat", "pong" -> Unit
                "state.snapshot", "state.changed" -> {
                    val snapshot = root["state"] ?: return
                    listener?.onSnapshot(json.decodeFromJsonElement(snapshot))
                }
                "pty.list" -> {
                    val rows = root["ptys"]?.jsonArray ?: return
                    listener?.onPtys(rows.map { json.decodeFromJsonElement<MobilePtyInfo>(it) })
                }
                "pty.spawned" -> root["ptyId"]?.jsonPrimitive?.intOrNull?.let { listener?.onPtySpawned(it) }
                "pty.snapshot" -> {
                    val ptyId = root["ptyId"]?.jsonPrimitive?.intOrNull ?: return
                    val bytes = decodeBytes(root)
                    listener?.onPtySnapshot(ptyId, bytes)
                }
                "pty.output" -> {
                    val ptyId = root["ptyId"]?.jsonPrimitive?.intOrNull ?: return
                    val bytes = decodeBytes(root)
                    val eof = root["eof"]?.jsonPrimitive?.contentOrNull == "true"
                    listener?.onPtyOutput(ptyId, bytes, eof)
                }
                "ack" -> {
                    val ok = root["ok"]?.jsonPrimitive?.contentOrNull == "true"
                    val error = root["error"]?.jsonPrimitive?.contentOrNull
                    listener?.onAck(ok, error)
                }
                "error" -> listener?.onError(root["message"]?.jsonPrimitive?.contentOrNull ?: "Unknown Sikemux error")
            }
        } catch (e: Exception) {
            listener?.onError("Bad server message: ${e.message}")
        }
    }

    private fun decodeBytes(root: JsonObject): ByteArray {
        val b64 = root["data"]?.jsonPrimitive?.contentOrNull.orEmpty()
        return Base64.decode(b64, Base64.DEFAULT)
    }
}

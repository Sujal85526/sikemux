package com.nodelike.sikemux.mobile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URLDecoder

class SikemuxViewModel(
    initialHost: String,
    initialToken: String,
) : ViewModel(), SikemuxClientListener {
    private val client = SikemuxClient()
    private val _ui = MutableStateFlow(UiState(host = initialHost, token = initialToken))
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private val _terminalEvents = MutableSharedFlow<TerminalEvent>(replay = 8, extraBufferCapacity = 128)
    val terminalEvents: SharedFlow<TerminalEvent> = _terminalEvents.asSharedFlow()

    fun setHost(value: String) = _ui.update { it.copy(host = value) }
    fun setToken(value: String) = _ui.update { it.copy(token = value) }
    fun setError(message: String?) = _ui.update { it.copy(error = message) }
    fun setIslandExpanded(value: Boolean) = _ui.update { it.copy(expandedIsland = value) }
    fun setTab(tab: ProjectTab) = _ui.update { it.copy(activeTab = tab) }

    fun applyPairingPayload(raw: String) {
        val parsed = parsePairingPayload(raw)
        if (parsed == null) {
            _ui.update { it.copy(error = "QR is not a Sikemux pairing code") }
            return
        }
        _ui.update { it.copy(host = parsed.host, token = parsed.token, error = null) }
        connect()
    }

    private fun parsePairingPayload(raw: String): PairingPayload? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (text.startsWith("{")) {
            return runCatching {
                val obj = Json.parseToJsonElement(text).jsonObject
                val type = obj["type"]?.jsonPrimitive?.contentOrNull
                if (type != "sikemux.mobile.pair") return@runCatching null
                val host = obj["wsUrl"]?.jsonPrimitive?.contentOrNull
                    ?: obj["url"]?.jsonPrimitive?.contentOrNull
                    ?: return@runCatching null
                val token = obj["token"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null
                PairingPayload(host = host, token = token)
            }.getOrNull()
        }
        if (text.startsWith("sikemux://pair")) {
            val query = text.substringAfter('?', "")
            val values = query.split('&')
                .mapNotNull { part ->
                    val key = part.substringBefore('=', missingDelimiterValue = "")
                    val value = part.substringAfter('=', missingDelimiterValue = "")
                    if (key.isBlank()) null else key to URLDecoder.decode(value, "UTF-8")
                }
                .toMap()
            val host = values["wsUrl"] ?: values["url"] ?: values["host"] ?: return null
            val token = values["token"] ?: return null
            return PairingPayload(host = host, token = token)
        }
        return null
    }

    fun connect() {
        val state = _ui.value
        if (state.host.isBlank() || state.token.isBlank()) {
            _ui.update { it.copy(error = "Host and token required") }
            return
        }
        _ui.update { it.copy(connecting = true, error = null) }
        client.connect(state.host, state.token, this)
    }

    fun disconnect() {
        client.close()
        _ui.update { it.copy(connected = false, connecting = false, activePtyId = null) }
    }

    fun selectProject(projectId: String) {
        _ui.update { it.copy(selectedProjectId = projectId, activeTab = ProjectTab.Terminals, activePtyId = null) }
        client.listPtys()
    }

    fun backToProjects() {
        client.detachPty()
        _ui.update { it.copy(selectedProjectId = null, activePtyId = null) }
    }

    fun refreshPtys() = client.listPtys()

    fun spawnMobileTerminal() {
        val project = _ui.value.selectedProject ?: return
        client.spawnPty(cwd = project.cwd, cols = 80, rows = 24)
    }

    fun spawnAgent(agentCommand: String) {
        val project = _ui.value.selectedProject ?: return
        _ui.update { it.copy(activeTab = ProjectTab.Terminals) }
        client.spawnPty(cwd = project.cwd, cols = 80, rows = 24, startup = agentCommand)
    }

    fun attachPty(ptyId: Int) {
        _ui.update { it.copy(activePtyId = ptyId, activeTab = ProjectTab.Terminals) }
        client.attachPty(ptyId)
    }

    fun detachPty() {
        client.detachPty()
        _ui.update { it.copy(activePtyId = null) }
    }

    fun sendTerminalInput(data: String) {
        val ptyId = _ui.value.activePtyId ?: return
        client.writePty(ptyId, data)
    }

    fun sendLine(line: String) {
        if (line.isEmpty()) return
        sendTerminalInput("$line\r")
    }

    fun resizeActivePty(cols: Int, rows: Int) {
        val ptyId = _ui.value.activePtyId ?: return
        client.resizePty(ptyId, cols, rows)
    }

    override fun onConnected() {
        _ui.update { it.copy(connected = true, connecting = false, error = null) }
    }

    override fun onDisconnected(reason: String?) {
        _ui.update {
            it.copy(
                connected = false,
                connecting = false,
                activePtyId = null,
                error = reason?.takeIf(String::isNotBlank),
            )
        }
    }

    override fun onError(message: String) {
        _ui.update { it.copy(error = message, connecting = false) }
    }

    override fun onSnapshot(snapshot: WorkspaceSnapshot) {
        _ui.update { current ->
            val projects = snapshot.sessions.filter { it.kind == "project" }
            val selected = current.selectedProjectId?.takeIf { id -> projects.any { it.id == id } }
                ?: snapshot.activeSessionId?.takeIf { id -> projects.any { it.id == id } }
                ?: projects.firstOrNull()?.id
            current.copy(snapshot = snapshot, selectedProjectId = selected)
        }
    }

    override fun onPtys(ptys: List<MobilePtyInfo>) {
        _ui.update { it.copy(ptys = ptys) }
    }

    override fun onPtySpawned(ptyId: Int) {
        client.listPtys()
        attachPty(ptyId)
    }

    override fun onPtySnapshot(ptyId: Int, bytes: ByteArray) {
        _ui.update { it.copy(activePtyId = ptyId) }
        viewModelScope.launch { _terminalEvents.emit(TerminalEvent.Reset(bytes)) }
    }

    override fun onPtyOutput(ptyId: Int, bytes: ByteArray, eof: Boolean) {
        if (eof) {
            _ui.update { state ->
                state.copy(activePtyId = state.activePtyId?.takeIf { it != ptyId })
            }
            client.listPtys()
            return
        }
        viewModelScope.launch { _terminalEvents.emit(TerminalEvent.Append(bytes)) }
    }

    override fun onAck(ok: Boolean, message: String?) {
        if (!ok) _ui.update { it.copy(error = message ?: "Command failed") }
    }

    override fun onCleared() {
        client.close()
    }
}

private data class PairingPayload(val host: String, val token: String)

class SikemuxViewModelFactory(
    private val initialHost: String,
    private val initialToken: String,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return SikemuxViewModel(initialHost, initialToken) as T
    }
}

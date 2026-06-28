package com.nodelike.sikemux.mobile

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class WorkspaceSnapshot(
    val version: Int? = null,
    val sessions: List<SikemuxSession> = emptyList(),
    val sessionOrder: List<String> = emptyList(),
    val activeSessionId: String? = null,
    val windowsBySession: Map<String, List<JsonElement>> = emptyMap(),
    val agentsBySession: Map<String, List<SikemuxAgent>> = emptyMap(),
)

@Serializable
data class SikemuxSession(
    val id: String,
    val name: String,
    val kind: String,
    val cwd: String = "",
    val pinned: Boolean = false,
    val activeWindowId: String = "",
    val activeAgentId: String? = null,
    val view: String = "windows",
)

@Serializable
data class SikemuxAgent(
    val id: String,
    val type: String,
    val title: String,
    val startup: String,
    val resumeId: String? = null,
    val createdAt: Long? = null,
    val skipPermissions: Boolean? = null,
)

@Serializable
data class MobilePtyInfo(
    val id: Int,
    val rows: Int,
    val cols: Int,
    val cwd: String = "",
    val startup: String? = null,
    val subscribers: Int = 0,
)

@Serializable
data class WsEnvelope(
    val type: String,
)

sealed interface TerminalEvent {
    data class Reset(val bytes: ByteArray) : TerminalEvent
    data class Append(val bytes: ByteArray) : TerminalEvent
}

data class UiState(
    val host: String = "",
    val token: String = "",
    val connected: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
    val expandedIsland: Boolean = false,
    val snapshot: WorkspaceSnapshot = WorkspaceSnapshot(),
    val ptys: List<MobilePtyInfo> = emptyList(),
    val selectedProjectId: String? = null,
    val activePtyId: Int? = null,
    val activeTab: ProjectTab = ProjectTab.Terminals,
) {
    val projects: List<SikemuxSession>
        get() = snapshot.sessions
            .filter { it.kind == "project" }
            .let { projects ->
                if (snapshot.sessionOrder.isEmpty()) projects
                else projects.sortedBy { snapshot.sessionOrder.indexOf(it.id).let { idx -> if (idx < 0) Int.MAX_VALUE else idx } }
            }

    val selectedProject: SikemuxSession?
        get() = projects.firstOrNull { it.id == selectedProjectId }
}

enum class ProjectTab { Agents, Terminals }

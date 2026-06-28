package com.nodelike.sikemux.mobile

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.ActivityCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions

private val Bg = Color(0xFF05070B)
private val Panel = Color(0xFF0B1020)
private val Panel2 = Color(0xFF111827)
private val TextMain = Color(0xFFE5EEF9)
private val TextMuted = Color(0xFF8EA0B8)
private val Green = Color(0xFF36D399)
private val Blue = Color(0xFF7DD3FC)
private val Red = Color(0xFFFB7185)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 48731)
        }
        val prefs = getSharedPreferences("sikemux-mobile", MODE_PRIVATE)
        val initialHost = prefs.getString("host", "") ?: ""
        val initialToken = prefs.getString("token", "") ?: ""

        setContent {
            val vm: SikemuxViewModel = viewModel(factory = SikemuxViewModelFactory(initialHost, initialToken))
            val state by vm.ui.collectAsStateWithLifecycle()

            LaunchedEffect(state.host, state.token) {
                prefs.edit()
                    .putString("host", state.host)
                    .putString("token", state.token)
                    .apply()
            }

            LaunchedEffect(
                state.connected,
                state.connecting,
                state.selectedProjectId,
                state.activePtyId,
                state.ptys,
                state.snapshot,
            ) {
                SikemuxNotificationService.update(this@MainActivity, state)
            }

            SikemuxMobileTheme {
                SikemuxApp(state = state, vm = vm)
            }
        }
    }
}

@Composable
private fun SikemuxMobileTheme(content: @Composable () -> Unit) {
    MaterialTheme(content = content)
}

private fun scanPairingQr(context: Context, vm: SikemuxViewModel) {
    val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .enableAutoZoom()
        .build()
    GmsBarcodeScanning.getClient(context, options)
        .startScan()
        .addOnSuccessListener { barcode ->
            val raw = barcode.rawValue.orEmpty()
            vm.applyPairingPayload(raw)
        }
        .addOnCanceledListener {
            vm.setError(null)
        }
        .addOnFailureListener { err ->
            vm.setError("QR scan failed: ${err.message ?: "Google scanner unavailable"}")
        }
}

@Composable
private fun SikemuxApp(state: UiState, vm: SikemuxViewModel) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(Color(0xFF0A1324), Bg, Bg),
                ),
            )
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(10.dp))
            LiveIsland(state = state, onToggle = { vm.setIslandExpanded(!state.expandedIsland) })
            Spacer(Modifier.height(16.dp))

            if (!state.connected) {
                ConnectScreen(state = state, vm = vm)
            } else {
                val project = state.selectedProject
                if (project == null) {
                    ProjectsScreen(state = state, onProject = vm::selectProject)
                } else {
                    ProjectScreen(state = state, project = project, vm = vm)
                }
            }
        }
    }
}

@Composable
private fun LiveIsland(state: UiState, onToggle: () -> Unit) {
    val scale by animateFloatAsState(if (state.connected) 1f else 0.98f, label = "island-scale")
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .scale(scale)
            .clip(RoundedCornerShape(if (state.expandedIsland) 34.dp else 28.dp))
            .clickable(onClick = onToggle),
        color = Color.Black.copy(alpha = 0.82f),
        tonalElevation = 8.dp,
        shadowElevation = 16.dp,
    ) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 13.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(if (state.connected) Green else Red),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("S", color = Bg, fontWeight = FontWeight.Black)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = if (state.connected) state.selectedProject?.name ?: "Sikemux connected" else "Sikemux mobile",
                        color = TextMain,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = when {
                            state.connecting -> "connecting..."
                            state.connected && state.activePtyId != null -> "terminal #${state.activePtyId} live"
                            state.connected -> "${state.projects.size} projects · ${state.ptys.size} terminals"
                            else -> "connect over Tailscale"
                        },
                        color = TextMuted,
                        maxLines = 1,
                    )
                }
                ActivityBars(active = state.connected)
            }
            AnimatedVisibility(state.expandedIsland) {
                Column(Modifier.padding(top = 14.dp)) {
                    Text(
                        text = state.error ?: if (state.connected) "Live workspace sync is running. Terminal writes are enabled after pairing." else "Start Sikemux desktop sync, paste host + token, then connect.",
                        color = if (state.error == null) TextMuted else Red,
                    )
                    if (state.connected) {
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Pill("refresh PTYs") { }
                            Pill("write enabled") { }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityBars(active: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf(13.dp, 22.dp, 16.dp).forEachIndexed { idx, h ->
            Box(
                Modifier
                    .width(4.dp)
                    .height(if (active) h else 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (active) listOf(Green, Blue, Green)[idx] else TextMuted.copy(alpha = 0.4f)),
            )
        }
    }
}

@Composable
private fun ConnectScreen(state: UiState, vm: SikemuxViewModel) {
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Connect to your Mac", color = TextMain, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
        Text(
            "Run Sikemux desktop sync over Tailscale, then paste the Mac host and pairing token.",
            color = TextMuted,
        )
        OutlinedTextField(
            value = state.host,
            onValueChange = vm::setHost,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Host", color = TextMuted) },
            placeholder = { Text("100.x.y.z:48731") },
            singleLine = true,
        )
        OutlinedTextField(
            value = state.token,
            onValueChange = vm::setToken,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Pairing token", color = TextMuted) },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = { scanPairingQr(context, vm) },
                enabled = !state.connecting,
                colors = ButtonDefaults.buttonColors(containerColor = Blue, contentColor = Bg),
                modifier = Modifier.weight(1f),
            ) {
                Text("Scan QR", fontWeight = FontWeight.Bold)
            }
            Button(
                onClick = vm::connect,
                enabled = !state.connecting,
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Bg),
                modifier = Modifier.weight(1f),
            ) {
                Text(if (state.connecting) "Connecting..." else "Connect", fontWeight = FontWeight.Bold)
            }
        }
        state.error?.let { Text(it, color = Red) }
        Card(colors = CardDefaults.cardColors(containerColor = Panel), shape = RoundedCornerShape(24.dp)) {
            Text(
                text = "Desktop command:\nSIKEMUX_MOBILE_SYNC=1 SIKEMUX_MOBILE_BIND=0.0.0.0:48731 pnpm tauri dev\n\nToken:\n~/.config/sikemux/mobile.token",
                color = TextMuted,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(16.dp),
            )
        }
    }
}

@Composable
private fun ProjectsScreen(state: UiState, onProject: (String) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Text("Projects", color = TextMain, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
        Spacer(Modifier.height(10.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.projects, key = { it.id }) { project ->
                val agents = state.snapshot.agentsBySession[project.id].orEmpty()
                val terminals = state.ptys.count { it.cwd == project.cwd }
                ProjectCard(project = project, agentCount = agents.size, terminalCount = terminals, onClick = { onProject(project.id) })
            }
        }
    }
}

@Composable
private fun ProjectCard(project: SikemuxSession, agentCount: Int, terminalCount: Int, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = Panel.copy(alpha = 0.92f)),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(project.name, color = TextMain, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
            Text(project.cwd, color = TextMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(8.dp))
            Text("$agentCount agents · $terminalCount terminals", color = Blue)
        }
    }
}

@Composable
private fun ProjectScreen(state: UiState, project: SikemuxSession, vm: SikemuxViewModel) {
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = vm::backToProjects) { Text("‹ Projects", color = Blue) }
            Spacer(Modifier.weight(1f))
            Text(project.name, color = TextMain, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = state.activeTab == ProjectTab.Terminals, onClick = { vm.setTab(ProjectTab.Terminals) }, label = { Text("Terminals") })
            FilterChip(selected = state.activeTab == ProjectTab.Agents, onClick = { vm.setTab(ProjectTab.Agents) }, label = { Text("Agents") })
        }
        Spacer(Modifier.height(10.dp))
        when (state.activeTab) {
            ProjectTab.Terminals -> TerminalTab(state = state, project = project, vm = vm)
            ProjectTab.Agents -> AgentsTab(state = state, project = project, vm = vm)
        }
    }
}

@Composable
private fun TerminalTab(state: UiState, project: SikemuxSession, vm: SikemuxViewModel) {
    val projectPtys = state.ptys.filter { it.cwd == project.cwd }
    if (state.activePtyId == null) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = vm::spawnMobileTerminal,
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Bg),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("New mobile terminal", fontWeight = FontWeight.Bold) }
            Text("Existing terminals", color = TextMuted)
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(projectPtys, key = { it.id }) { pty ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { vm.attachPty(pty.id) },
                        shape = RoundedCornerShape(20.dp),
                        colors = CardDefaults.cardColors(containerColor = Panel2),
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("PTY #${pty.id}", color = TextMain, fontWeight = FontWeight.Bold)
                                Text("${pty.cols}×${pty.rows} · ${pty.subscribers} viewers", color = TextMuted)
                            }
                            Text("Open", color = Green)
                        }
                    }
                }
            }
        }
    } else {
        ActiveTerminal(state = state, vm = vm)
    }
}

@Composable
private fun ActiveTerminal(state: UiState, vm: SikemuxViewModel) {
    var composer by remember(state.activePtyId) { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("PTY #${state.activePtyId}", color = TextMain, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = vm::detachPty) { Text("Close view", color = Blue) }
        }
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            color = Bg,
            shape = RoundedCornerShape(18.dp),
        ) {
            TerminalWebView(events = vm.terminalEvents, onInput = vm::sendTerminalInput)
        }
        Spacer(Modifier.height(8.dp))
        TerminalControls(vm = vm)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = composer,
                onValueChange = { composer = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("type command / prompt") },
                singleLine = false,
                maxLines = 3,
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    vm.sendLine(composer)
                    composer = ""
                },
                colors = ButtonDefaults.buttonColors(containerColor = Green, contentColor = Bg),
            ) { Text("Send", fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun TerminalControls(vm: SikemuxViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Control("Esc") { vm.sendTerminalInput("\u001b") }
        Control("Tab") { vm.sendTerminalInput("\t") }
        Control("Ctrl-C") { vm.sendTerminalInput("\u0003") }
        Control("↑") { vm.sendTerminalInput("\u001b[A") }
        Control("↓") { vm.sendTerminalInput("\u001b[B") }
        Control("←") { vm.sendTerminalInput("\u001b[D") }
        Control("→") { vm.sendTerminalInput("\u001b[C") }
    }
}

@Composable
private fun AgentsTab(state: UiState, project: SikemuxSession, vm: SikemuxViewModel) {
    val agents = state.snapshot.agentsBySession[project.id].orEmpty()
    val mobileAgentPtys = state.ptys.filter { it.cwd == project.cwd && !it.startup.isNullOrBlank() }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Start agent", color = TextMuted)
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("pi", "claude", "codex", "hermes", "opencode").forEach { cmd ->
                Control(cmd) { vm.spawnAgent(cmd) }
            }
        }

        if (mobileAgentPtys.isNotEmpty()) {
            Text("Mobile agent terminals", color = TextMuted)
            mobileAgentPtys.forEach { pty ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { vm.attachPty(pty.id) },
                    colors = CardDefaults.cardColors(containerColor = Panel2),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(pty.startup ?: "agent", color = TextMain, fontWeight = FontWeight.Bold)
                        Text("PTY #${pty.id} · tap to open", color = TextMuted)
                    }
                }
            }
        }

        if (agents.isNotEmpty()) {
            Text("Desktop agent rail", color = TextMuted)
            agents.forEach { agent ->
                Card(colors = CardDefaults.cardColors(containerColor = Panel2), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(14.dp)) {
                        Text(agent.title, color = TextMain, fontWeight = FontWeight.Bold)
                        Text(agent.type + (agent.resumeId?.let { " · resume $it" } ?: ""), color = TextMuted)
                    }
                }
            }
        }

        if (agents.isEmpty() && mobileAgentPtys.isEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = Panel), shape = RoundedCornerShape(24.dp)) {
                Text(
                    "Start a mobile-native agent above. It runs on your Mac in this project and opens as a live terminal.",
                    color = TextMuted,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    }
}

@Composable
private fun Control(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        color = TextMain,
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Panel2)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 8.dp),
        fontWeight = FontWeight.Bold,
    )
}

@Composable
private fun Pill(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        color = TextMain,
        modifier = Modifier
            .clip(RoundedCornerShape(50.dp))
            .background(Panel2)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

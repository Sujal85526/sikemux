//! While remote access is on, the background core starts when the person logs
//! in, so a paired device reaches this host after a restart without Sikemux
//! being opened. A LaunchAgent on macOS, or a systemd user service elsewhere,
//! runs the same command the app starts the core with; turning remote access
//! off removes it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use launchd as service;
#[cfg(not(target_os = "macos"))]
use systemd as service;

/// How the app starts the core, which the login item repeats.
pub(crate) struct CoreLaunch {
    pub binary: PathBuf,
    pub socket: PathBuf,
    pub log: PathBuf,
    pub args: Vec<OsString>,
}

impl CoreLaunch {
    fn command(&self) -> impl Iterator<Item = String> + '_ {
        [
            self.binary.as_os_str(),
            "core".as_ref(),
            "--socket".as_ref(),
            self.socket.as_os_str(),
        ]
        .into_iter()
        .chain(self.args.iter().map(OsString::as_os_str))
        .map(|arg| arg.to_string_lossy().into_owned())
    }
}

pub(crate) fn label(identifier: &str) -> String {
    format!("{identifier}.core")
}

/// True when the file was written.
fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<bool> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)?;
    Ok(true)
}

fn quiet(program: &str, args: &[&str]) {
    let _ = sikemux_process::user_environment::command(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Installs or removes the login item to match `enabled`. Installing takes
/// effect at the next login; the core already runs for this one.
pub(crate) fn sync(identifier: &str, launch: Option<&CoreLaunch>, enabled: bool) {
    let label = label(identifier);
    let Some(path) = service::path(&label) else {
        return;
    };
    if enabled {
        let Some(launch) = launch else {
            return;
        };
        let path_env = crate::system::child_path();
        let contents = service::render(&label, launch, path_env.as_deref());
        match write_if_changed(&path, &contents) {
            Ok(true) => service::installed(&label),
            Ok(false) => {}
            Err(error) => eprintln!("Sikemux could not start its core at login: {error}"),
        }
        return;
    }
    if !path.exists() {
        return;
    }
    service::stop(&label);
    if let Err(error) = std::fs::remove_file(&path) {
        eprintln!("Sikemux could not stop starting its core at login: {error}");
    }
}

#[cfg(target_os = "macos")]
mod launchd {
    use std::path::PathBuf;

    use super::{quiet, CoreLaunch};

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    fn string(value: impl AsRef<std::ffi::OsStr>) -> String {
        format!(
            "<string>{}</string>",
            escape(&value.as_ref().to_string_lossy())
        )
    }

    pub(super) fn path(label: &str) -> Option<PathBuf> {
        Some(
            sikemux_process::paths::home()?
                .join("Library/LaunchAgents")
                .join(format!("{label}.plist")),
        )
    }

    /// Started at login, and again only if it crashed, so Quit and Stop
    /// Everything or a second core finding one running stays stopped. Without
    /// `Interactive`, launchd runs it at background priority, and so every
    /// shell it starts.
    pub(super) fn render(label: &str, launch: &CoreLaunch, path_env: Option<&str>) -> String {
        let arguments: Vec<String> = launch.command().map(string).collect();
        let environment = path_env
            .map(|path| {
                format!(
                    "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    {}\n  </dict>\n",
                    string(path)
                )
            })
            .unwrap_or_default();
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  {label}
  <key>ProgramArguments</key>
  <array>
    {arguments}
  </array>
{environment}  <key>ProcessType</key>
  <string>Interactive</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  {log}
  <key>StandardErrorPath</key>
  {log}
</dict>
</plist>
"#,
            label = string(label),
            arguments = arguments.join("\n    "),
            log = string(&launch.log),
        )
    }

    /// launchd reads the folder itself at the next login.
    pub(super) fn installed(_label: &str) {}

    pub(super) fn stop(label: &str) {
        // SAFETY: getuid takes no arguments, cannot fail and touches no memory.
        let uid = unsafe { libc::getuid() };
        quiet(
            "/bin/launchctl",
            &["bootout", &format!("gui/{uid}/{label}")],
        );
    }
}

#[cfg(not(target_os = "macos"))]
mod systemd {
    use std::path::{Path, PathBuf};

    use super::{quiet, CoreLaunch};

    fn unit(label: &str) -> String {
        format!("{label}.service")
    }

    /// systemd expands `%` in every value.
    fn quote(text: &str) -> String {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%");
        format!("\"{escaped}\"")
    }

    pub(super) fn path(label: &str) -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| Some(sikemux_process::paths::home()?.join(".config")))?;
        Some(config.join("systemd/user").join(unit(label)))
    }

    /// Restarted only after a crash, so Quit and Stop Everything or a second
    /// core finding one running stays stopped.
    pub(super) fn render(_label: &str, launch: &CoreLaunch, path_env: Option<&str>) -> String {
        let command: Vec<String> = launch
            .command()
            .map(|arg| quote(&arg.replace('$', "$$")))
            .collect();
        let environment = path_env
            .map(|path| format!("Environment={}\n", quote(&format!("PATH={path}"))))
            .unwrap_or_default();
        format!(
            "[Unit]
Description=Sikemux core

[Service]
ExecStart={command}
{environment}Restart=on-failure
RestartSec=2
StandardOutput=append:{log}
StandardError=append:{log}

[Install]
WantedBy=default.target
",
            command = command.join(" "),
            log = launch.log.to_string_lossy().replace('%', "%%"),
        )
    }

    /// A user service starts at login; only lingering starts it at boot, which
    /// a host nobody logs in to needs.
    pub(super) fn installed(label: &str) {
        quiet("systemctl", &["--user", "daemon-reload"]);
        quiet("systemctl", &["--user", "enable", &unit(label)]);
        let lingering = std::env::var("USER")
            .is_ok_and(|user| Path::new("/var/lib/systemd/linger").join(user).exists());
        if !lingering {
            eprintln!(
                "Sikemux's core now starts when you log in. To start it at boot, run: loginctl enable-linger"
            );
        }
    }

    pub(super) fn stop(label: &str) {
        quiet("systemctl", &["--user", "disable", "--now", &unit(label)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    fn launch() -> CoreLaunch {
        CoreLaunch {
            binary: "/Applications/Sikemux.app/Contents/MacOS/sikemux-editor".into(),
            socket: "/Users/me/.config/sikemux/core.sock".into(),
            log: "/Users/me/Library/Logs/com.nodelike.sikemux/core.log".into(),
            args: vec![
                "--data-dir".into(),
                "/Users/me/Library/Application Support/A&B".into(),
            ],
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_agent_runs_the_core_the_way_the_app_does() {
        let plist = service::render(
            "com.nodelike.sikemux.core",
            &launch(),
            Some("/usr/bin:/bin"),
        );
        assert!(plist.contains("<string>com.nodelike.sikemux.core</string>"));
        assert!(plist.contains(
            "<string>/Applications/Sikemux.app/Contents/MacOS/sikemux-editor</string>\n    <string>core</string>\n    <string>--socket</string>\n    <string>/Users/me/.config/sikemux/core.sock</string>\n    <string>--data-dir</string>"
        ));
        assert!(plist.contains("Application Support/A&amp;B"));
        assert!(plist.contains("<key>PATH</key>\n    <string>/usr/bin:/bin</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n    <false/>"));
    }

    #[test]
    fn an_unchanged_agent_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Library/LaunchAgents/x.plist");
        write_if_changed(&path, "one").unwrap();
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_if_changed(&path, "one").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            written
        );
        write_if_changed(&path, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    }
}

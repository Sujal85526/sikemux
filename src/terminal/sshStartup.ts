export const SSH_MAX_RETRIES = 5;

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Run SSH through the user's login shell instead of leaving a dead transport
 * as the terminal's last state. A normal logout returns straight to the shell;
 * failed connections restore terminal modes and retry at most five times.
 */
export function sshStartup(alias: string): string {
    const host = shellQuote(alias);
    // Pty startup is injected into readline as a single input line. Newlines
    // here are not Enter keypresses and can leave a giant unexecuted script
    // in the terminal buffer, so keep this POSIX shell program on one line.
    return `sikemux_ssh_retries=0; while :; do command ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ${host}; sikemux_ssh_status=$?; stty sane 2>/dev/null || true; printf '\\033[0m\\033[?25h\\033[?1l\\033>\\033[?2004l\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l'; if [ "$sikemux_ssh_status" -eq 0 ]; then break; fi; if [ "$sikemux_ssh_status" -eq 130 ]; then printf '\\r\\nSSH reconnect cancelled. Back at your local shell.\\r\\n'; break; fi; if [ "$sikemux_ssh_retries" -ge ${SSH_MAX_RETRIES} ]; then printf '\\r\\nSSH could not reconnect after ${SSH_MAX_RETRIES} retries. Back at your local shell.\\r\\n'; break; fi; sikemux_ssh_retries=$((sikemux_ssh_retries + 1)); printf '\\r\\nSSH connection lost. Retrying (%s/${SSH_MAX_RETRIES}) in 3 seconds… Press Ctrl-C to stop.\\r\\n' "$sikemux_ssh_retries"; sleep 3 || break; done`;
}

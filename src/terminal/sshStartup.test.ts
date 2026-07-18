import { describe, expect, it } from "vitest";
import { SSH_MAX_RETRIES, sshStartup } from "./sshStartup";

describe("sshStartup", () => {
    it("uses keepalives and stops after five retries", () => {
        const startup = sshStartup("prod-db");

        expect(SSH_MAX_RETRIES).toBe(5);
        expect(startup).toContain("ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 'prod-db'");
        expect(startup).toContain('if [ "$sikemux_ssh_retries" -ge 5 ]; then');
        expect(startup).toContain("Retrying (%s/5)");
        expect(startup).toContain("sleep 3 || break");
    });

    it("quotes SSH aliases before passing them to the shell", () => {
        expect(sshStartup("host'; touch nope; echo '")).toContain("'host'\"'\"'; touch nope; echo '\"'\"''");
    });

    it("restores terminal input modes after every SSH exit", () => {
        expect(sshStartup("prod-db")).toContain("stty sane");
        expect(sshStartup("prod-db")).toContain("\\033[?2004l");
        expect(sshStartup("prod-db")).toContain("SSH reconnect cancelled");
    });
});

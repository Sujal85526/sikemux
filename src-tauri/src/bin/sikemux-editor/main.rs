//! The `sikemux` command and `$EDITOR` inside Sikemux terminals. Agents start
//! the same binary with `--tools-mcp` to reach their browser and workspace tools.

#[path = "../../cli_auth.rs"]
mod cli_auth;
mod tools_mcp;

use sikemux_lib::cli_client;

fn main() {
    let code = if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == cli_client::TOOLS_MCP_FLAG)
    {
        tools_mcp::run()
    } else {
        cli_client::run()
    };
    std::process::exit(code);
}

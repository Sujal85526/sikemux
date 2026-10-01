/// `sikemux core …`: the background process that owns terminals. See
/// [`sikemux_core::server::main`].
pub fn run() -> i32 {
    sikemux_core::server::main(std::env::args().skip(2), sikemux_lib::build_identity())
}

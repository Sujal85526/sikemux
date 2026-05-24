.PHONY: dev build run tsc check clean

# dev hot-reload — vite + tauri attached
dev:
	pnpm tauri dev

# production app bundle (.app + .dmg under src-tauri/target/release/bundle)
build:
	pnpm tauri build

# run the already-built release binary without rebundling
run:
	./src-tauri/target/release/sikemux

# typecheck the frontend without emitting
tsc:
	pnpm tsc --noEmit

# typecheck rust
check:
	cd src-tauri && cargo check

clean:
	cd src-tauri && cargo clean
	rm -rf dist node_modules/.vite

.PHONY: dev build run tsc check clean icons

# Single source of truth for the app icon: src-tauri/icons/sikemux.icon
# Both dev and build depend on `icons` so the Liquid Glass artwork drives
# every binary's dock appearance.
icons:
	./scripts/icons.sh

# dev hot-reload — vite + tauri attached. icons.sh also runs as part of
# tauri.conf.json's beforeDevCommand, but we declare the dependency here
# so a bare `make dev` is self-contained.
dev: icons
	pnpm tauri dev

# production app bundle (.app + .dmg under src-tauri/target/release/bundle)
# with Liquid Glass icon properly injected.
build: icons
	./scripts/build-mac.sh

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

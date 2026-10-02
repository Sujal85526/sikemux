import { useEffect, useRef } from "react";

/** The desktop app's ambient grain: Bayer dots over drifting noise, in Aura Noir's raised tone. */
export function Backdrop() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

    void import("@paper-design/shaders").then(
      ({
        ShaderMount,
        ditheringFragmentShader,
        DitheringShapes,
        DitheringTypes,
        ShaderFitOptions,
        getShaderColorFromString,
      }) => {
        if (cancelled) return;
        try {
          const mount = new ShaderMount(
            element,
            ditheringFragmentShader,
            {
              u_colorBack: [0, 0, 0, 0],
              u_colorFront: getShaderColorFromString("#232329"),
              u_shape: DitheringShapes.simplex,
              u_type: DitheringTypes["8x8"],
              u_pxSize: 3,
              u_fit: ShaderFitOptions.none,
              u_scale: 2.4,
              u_rotation: 0,
              u_offsetX: 0,
              u_offsetY: 0,
              u_originX: 0.5,
              u_originY: 0.5,
              u_worldWidth: 0,
              u_worldHeight: 0,
            },
            { antialias: false },
            still ? 0 : 0.35,
          );
          dispose = () => mount.dispose();
          element.dataset.ready = "";
        } catch {
          // Without WebGL the plain ground is the page, which is designed to stand alone.
        }
      },
    );

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return <div ref={host} className="backdrop" aria-hidden="true" />;
}

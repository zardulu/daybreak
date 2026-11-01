import { useEffect, useRef, useSyncExternalStore } from 'react';
import { GrainGradient, type PaperShaderElement } from '@paper-design/shaders-react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Measured: a static frame costs nothing; per-frame GPU cost is dominated by compositing the
// full-window canvas, not by shader pixels. The library has no fps cap, so we cap it ourselves:
// speed: 0 stops its own loop and we call setFrame (ms of animation time) on the mount directly via
// ref at MAX_FPS, advancing it by SPEED per real ms. Not a `frame` prop: each re-render also rebuilds
// the wrapper's uniforms, so a prop change draws twice; setFrame draws exactly once.
// minPixelRatio is a floor: 0.5 stops the default 2x supersampling on 1x screens.
// Rendered at device resolution so the grain stays fine (library default pixel cap). Measured ~60% GPU on an M1 at 4096x1968; set maxPixelCount (e.g. 1280 * 720, ~18%) to trade grain detail for GPU.
// Under reduced motion the gradient is still shown but frozen (the loop never starts; a static frame costs no GPU).
const SHADER = {
    colors: ['#7300ff', '#eba8ff', '#00bfff', '#2a00ff'], // violet, lilac, sky, indigo
    colorBack: '#f6e0e0',
    softness: 0.5,
    intensity: 1,
    noise: 0.25,
    shape: 'corners' as const,
    speed: 0,
    minPixelRatio: 0.5,
    // Opaque canvas skips per-frame alpha compositing of the full window, measured as the dominant GPU cost.
    webGlContextAttributes: { alpha: false },
};
const SPEED = 0.4;
const MAX_FPS = 30;

const subscribeReducedMotion = (onChange: () => void) => {
    const query = window.matchMedia(REDUCED_MOTION);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
};

const getReducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;

export default function Background() {
    const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion);
    const mountRef = useRef<PaperShaderElement>(null);

    useEffect(() => {
        if (reducedMotion) return;
        let raf = 0;
        let last = performance.now();
        let pending = 0;
        let frame = 0;
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick);
            // Clamp so a long gap (backgrounded tab) can't jump the animation.
            const dt = Math.min(Math.max(now - last, 0), 50);
            last = now;
            if (document.hidden) return;
            pending += dt;
            if (pending >= 1000 / MAX_FPS - 2) {
                frame += pending * SPEED;
                pending = 0;
                // Undefined until the library's init effect creates the mount.
                mountRef.current?.paperShaderMount?.setFrame(frame);
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [reducedMotion]);

    return (
        <div className="sr-ground" aria-hidden="true">
            <GrainGradient
                className="sr-ground-shader"
                style={{ width: '100%', height: '100%' }}
                {...SHADER}
                ref={mountRef}
            />
            <div className="sr-ground-veil" />
        </div>
    );
}

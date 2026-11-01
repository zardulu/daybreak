import { useEffect, useRef, useSyncExternalStore } from 'react';
import { MeshGradient, type PaperShaderElement } from '@paper-design/shaders-react';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Measured: a static frame costs nothing; per-frame GPU cost is dominated by compositing the
// full-window canvas, not by shader pixels. The library has no fps cap, so we cap it ourselves:
// speed: 0 stops its own loop and we call setFrame (ms of animation time) on the mount directly via
// ref at MAX_FPS, advancing it by SPEED per real ms. Not a `frame` prop: each re-render also rebuilds
// the wrapper's uniforms, so a prop change draws twice; setFrame draws exactly once.
// minPixelRatio is a floor: 0.5 stops the default 2x supersampling on 1x screens.
// maxPixelCount is the hard cap on canvas pixels; lower renders softer (pixel savings are minor).
// Under reduced motion the gradient is still shown but frozen (the loop never starts; a static frame costs no GPU).
const SHADER = {
    colors: ['#829dd4', '#6f6acd', '#d586a6', '#9f50d3'], // blue, indigo, pink, purple
    distortion: 0.8,
    swirl: 0.55,
    speed: 0,
    minPixelRatio: 0.5,
    maxPixelCount: 640 * 400,
    // Opaque canvas skips per-frame alpha compositing of the full window, measured as the dominant GPU cost.
    webGlContextAttributes: { alpha: false },
};
const SPEED = 0.2;
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
            // Clamp so a long gap (backgrounded tab, blur) can't jump the animation.
            const dt = Math.min(Math.max(now - last, 0), 50);
            last = now;
            if (document.hidden || !document.hasFocus()) return;
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
            <MeshGradient
                className="sr-ground-shader"
                style={{ width: '100%', height: '100%' }}
                {...SHADER}
                ref={mountRef}
            />
            <div className="sr-ground-veil" />
        </div>
    );
}

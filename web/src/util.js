export function lerp_scalar(start, target, frac) {
    return start + (target - start) * frac;
}

export function ease(x) {
    return (1 - Math.cos(Math.PI * x)) / 2 * Math.sign(x);
}


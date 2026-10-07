// Full-screen background quad: the 2x2 plane's corners are written straight
// into clip space, so it always covers the viewport whatever the camera's
// zoom, aspect or orientation (the fragment shader works from gl_FragCoord).
// Depth sits at the far plane so everything else in the scene draws over it.
varying vec2 vUv;
void main() {
    vUv = vec2( uv.x, uv.y );
    gl_Position = vec4( position.xy, 0.9999, 1.0 );
}

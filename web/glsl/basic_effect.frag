// Basic effect shader that operates on an underlying scene
// Compatible with ShaderEffectScene

uniform vec3 iResolution;       // Viewport resolution (width, height, aspect ratio)
uniform float iTime;            // Shader playback time (in seconds)
uniform float iTimeDelta;       // Time since last frame
uniform int iFrame;             // Shader playback frame
uniform vec4 iMouse;            // Mouse position (xy: current, zw: click)
uniform sampler2D iChannel0;    // Previous frame (for feedback effects)
uniform sampler2D iBackgroundTexture; // The underlying scene's render

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = fragCoord / iResolution.xy;
    
    // Apply a simple wave distortion to the UV coordinates
    float distortionStrength = 0.02;
    float distortionFrequency = 5.0;
    vec2 distortedUV = uv + vec2(
        distortionStrength * sin(uv.y * distortionFrequency + iTime),
        distortionStrength * cos(uv.x * distortionFrequency + iTime)
    );
    
    // Sample the background texture with distorted UVs
    vec4 bgColor = texture(iBackgroundTexture, distortedUV);
    
    // Apply a vignette effect
    float vignette = 1.0 - length(uv - 0.5) * 0.8;
    vignette = smoothstep(0.0, 1.0, vignette);
    
    // Combine effects
    fragColor = bgColor * vignette;
    
    // At corners, show original image for comparison
    if (uv.x < 0.1 && uv.y < 0.1) {
        fragColor = texture(iBackgroundTexture, uv);
    }
}

void main() {
    // Call the Shadertoy-style mainImage function
    mainImage(gl_FragColor, gl_FragCoord.xy);
}

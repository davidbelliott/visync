import * as THREE from 'three';

// An exactly 1 px outline round the silhouette of everything on one layer,
// drawn in screen space after the scene: the layer's objects are drawn into
// a mask the size of the target the scene went to (made on first use and on
// a size change), then a full-screen pass colours every pixel just outside
// them (4-neighbour, so 1 px whatever the size or zoom). Only the outermost
// silhouette: inner folds never outline.
//
// Two options:
// - depth: the outline sits at the depth of the silhouette it borders and is
//   depth-tested against the scene's own depth (still in the target), so it
//   hides behind whatever is in front, as the objects themselves do. The mask
//   then carries a depth texture, and each outline pixel takes the nearest
//   depth among its silhouette neighbours as gl_FragDepth. Without it, the
//   outline is drawn over everything.
// - fade: the mask's blue is each silhouette pixel's opacity (0..1, e.g. a
//   prop fading with the fog), and the outline dissolves by its neighbours'
//   through a 4x4 Bayer dither, as dithered props do (the mask itself stays
//   whole, or its holes would all outline).
// - ids (with depth): outline each part of the layer round its own
//   silhouette, wherever it is in front of another or of nothing, not just
//   round their union. The mask's red is each pixel's part id (/255, unique
//   among the parts), green whether that part is outlined (0: it only hides
//   what is behind it); an outline pixel is one next to a nearer outlined
//   part with another id, at that part's depth.
// - rings: that many extra outlines of the silhouette scaled about a centre
//   (ring_scale[i] times, at opacity ring_alpha[i]; 0: off), white, blended
//   over the scene and into the outline where they cross it.
//
// The mask is drawn with mask_material over every object (e.g. flat white)
// or, if null, with their own materials, so ones dissolving through a dither
// outline as far as they show. Either way it is read as alpha, so it needs
// opaque materials. Lights stay out of it (they are on other layers), so it
// is cheap; shadow maps aren't redrawn for it.
export class SilhouetteOutline {
    // layer: the objects' extra layer (callers enable it on them). color:
    // THREE.Color. enabled: whether the outline itself draws (rings draw
    // either way).
    constructor({ layer, color, enabled = true, depth = false, fade = false, ids = false, rings = 0,
                  mask_material = null }) {
        this.layer = layer;
        this.depth = depth;
        this.rings = rings;
        this.mask_material = mask_material;
        this.mask = null;
        this.uniforms = {
            mask: { value: null },
            mask_depth: { value: null },
            color: { value: color },
            outline_on: { value: enabled ? 1 : 0 },
            center: { value: new THREE.Vector2() },     // rings' centre, target px
            ring_scale: { value: new Float32Array(Math.max(1, rings)).fill(1) },
            ring_alpha: { value: new Float32Array(Math.max(1, rings)) },
        };
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            defines: Object.assign({ RINGS: rings, RING_N: Math.max(1, rings) },
                depth ? { DEPTH: 1 } : {}, fade ? { FADE: 1 } : {}, ids ? { IDS: 1 } : {}),
            vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: [
                'uniform sampler2D mask;',
                'uniform vec3 color;',
                'uniform float outline_on;',
                'uniform vec2 center;',
                'uniform float ring_scale[RING_N];',
                'uniform float ring_alpha[RING_N];',
                '#ifdef DEPTH',
                'uniform sampler2D mask_depth;',
                '#endif',
                // The mask's texel under pixel p of the silhouette scaled by s
                // about center.
                'ivec2 texel(vec2 p, float s) {',
                '    ivec2 size = textureSize(mask, 0);',
                '    return clamp(ivec2(floor(center + (p - center) / s)), ivec2(0), size - 1);',
                '}',
                'float inside(vec2 p, float s) {',
                '    return texelFetch(mask, texel(p, s), 0).a;',
                '}',
                // Whether p is on that silhouette's 1 px outline: just outside it.
                'float ring(vec2 p, float s) {',
                '    if (inside(p, s) > 0.5) return 0.0;',
                '    float n = inside(p + vec2(1.0, 0.0), s) + inside(p - vec2(1.0, 0.0), s) +',
                '        inside(p + vec2(0.0, 1.0), s) + inside(p - vec2(0.0, 1.0), s);',
                '    return n > 0.5 ? 1.0 : 0.0;',
                '}',
                // Among p's neighbours inside the silhouette: the nearest depth
                // (x; DEPTH) and the most opaque (y; FADE).
                'vec2 edge_of(vec2 p) {',
                '    vec2 e = vec2(1.0, 0.0);',
                '    vec2 steps[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));',
                '    for (int k = 0; k < 4; k++) {',
                '        vec2 q = p + steps[k];',
                '        if (inside(q, 1.0) > 0.5) {',
                '#ifdef DEPTH',
                '            e.x = min(e.x, texelFetch(mask_depth, texel(q, 1.0), 0).r);',
                '#endif',
                '            e.y = max(e.y, texelFetch(mask, texel(q, 1.0), 0).b);',
                '        }',
                '    }',
                '    return e;',
                '}',
                '#ifdef IDS',
                // Whether p is next to a nearer outlined part (x), and that
                // part's nearest depth (y) and most opaque opacity (z).
                'vec3 id_edge(vec2 p) {',
                '    vec4 m = texelFetch(mask, texel(p, 1.0), 0);',
                '    float dp = m.a > 0.5 ? texelFetch(mask_depth, texel(p, 1.0), 0).r : 1.0;',
                '    vec3 e = vec3(0.0, 1.0, 0.0);',
                '    vec2 steps[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));',
                '    for (int k = 0; k < 4; k++) {',
                '        ivec2 q = texel(p + steps[k], 1.0);',
                '        vec4 n = texelFetch(mask, q, 0);',
                '        if (n.a < 0.5 || n.g < 0.5 || abs(n.r - m.r) < 0.5 / 255.0) continue;',
                '        float dq = texelFetch(mask_depth, q, 0).r;',
                '        if (dq < dp) e = vec3(1.0, min(e.y, dq), max(e.z, n.b));',
                '    }',
                '    return e;',
                '}',
                '#endif',
                'void main() {',
                '    vec2 p = gl_FragCoord.xy;',
                '#ifdef IDS',
                '    vec3 ie = id_edge(p);',
                '    float base = outline_on * ie.x;',
                '#else',
                '    float base = outline_on * ring(p, 1.0);',
                '#endif',
                '    float a = 0.0;',
                '#if RINGS > 0',
                '    for (int i = 0; i < RINGS; i++) {',
                '        if (ring_alpha[i] > 0.0) a = max(a, ring_alpha[i] * ring(p, ring_scale[i]));',
                '    }',
                '#endif',
                '    if (base < 0.5 && a <= 0.0) discard;',
                '#ifdef IDS',
                '    vec2 e = ie.yz;',
                '#else',
                '    vec2 e = edge_of(p);',
                '#endif',
                '#ifdef FADE',
                '    const float bayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,',
                '        3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);',
                '    ivec2 b = ivec2(mod(p, 4.0));',
                '    if (base > 0.5 && e.y <= (bayer[b.x + 4 * b.y] + 0.5) / 16.0) discard;',
                '#endif',
                '#ifdef DEPTH',
                '    gl_FragDepth = e.x;',
                '#endif',
                '    gl_FragColor = base > 0.5 ? vec4(mix(color, vec3(1.0), a), 1.0) : vec4(vec3(1.0), a);',
                // Colours are linear, as for the scene's own lines.
                '    #include <colorspace_fragment>',
                '}',
            ].join('\n'),
            transparent: true,
            depthTest: depth,
            depthWrite: false,
        }));
        this.quad.frustumCulled = false;
        this.scene = new THREE.Scene();
        this.scene.add(this.quad);
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.size = new THREE.Vector2();       // target px, as of the last draw
        this.clear_color = new THREE.Color();
    }

    // Draw scene's layer objects (from camera) into the mask, then the
    // outline into whatever target the scene was drawn to (the screen, or a
    // crossfade's buffer). before_quad(size), if given, runs between, e.g. to
    // set the rings' centre in target pixels.
    draw(renderer, scene, camera, before_quad = null) {
        const target = renderer.getRenderTarget();
        const size = target ? this.size.set(target.width, target.height) :
            renderer.getDrawingBufferSize(this.size);
        if (this.mask === null || this.mask.width != size.x || this.mask.height != size.y) {
            this.mask?.dispose();
            this.mask = new THREE.WebGLRenderTarget(size.x, size.y, this.depth ?
                { depthBuffer: true, depthTexture: new THREE.DepthTexture(size.x, size.y) } :
                { depthBuffer: false });
            this.uniforms.mask.value = this.mask.texture;
            this.uniforms.mask_depth.value = this.mask.depthTexture ?? null;
        }

        // The mask: only the layer, on clear (alpha 0), without redrawing the
        // shadow map.
        const layers = camera.layers.mask;
        const auto_shadows = renderer.shadowMap.autoUpdate;
        const clear_alpha = renderer.getClearAlpha();
        renderer.getClearColor(this.clear_color);
        renderer.shadowMap.autoUpdate = false;
        camera.layers.set(this.layer);
        const override = scene.overrideMaterial;
        scene.overrideMaterial = this.mask_material;
        renderer.setRenderTarget(this.mask);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(scene, camera);
        scene.overrideMaterial = override;
        camera.layers.mask = layers;
        renderer.shadowMap.autoUpdate = auto_shadows;
        renderer.setClearColor(this.clear_color, clear_alpha);

        before_quad?.(size);
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.camera);
    }
}

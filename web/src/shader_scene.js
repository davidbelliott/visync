import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { ResourceLoader } from './util.js';

const shader_preamble = [
'uniform vec3 iResolution;       // Viewport resolution (width, height, aspect ratio)',
'uniform float iTime;            // Shader playback time (in seconds)',
'uniform float iTimeDelta;       // Time since last frame',
'uniform int iFrame;             // Shader playback frame',
'uniform vec4 iMouse;            // Mouse position (xy: current, zw: click)',
'uniform sampler2D iChannel0;    // Previous frame (for feedback effects)',
'uniform sampler2D iBackgroundTexture; // The underlying scene\'s render',
].join('\n');

const shader_epilogue = ['void main() {',
'   mainImage(gl_FragColor, gl_FragCoord.xy);',
'}',
].join('\n');

export class ShaderScene extends VisScene {
    constructor(context, fragmentShaderUrl) {
        super(context, `shader:${fragmentShaderUrl}`);
        
        // Setup basic scene with a full-screen quad
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        
        // Create our shader loader
        this.loadShader(fragmentShaderUrl);
        
        // Setup render targets
        this.renderTarget = null;
        this.backgroundTarget = null;
        
        // Track initialization state
        this.initialized = false;
    }
    
    async loadShader(fragmentShaderUrl) {
        try {
            // Load the vertex and fragment shaders
            const shaderLoader = new ResourceLoader(['glsl/default.vert', fragmentShaderUrl]);
            const [vertexShader, fragmentChunk] = await shaderLoader.load();
            const fragmentShader = shader_preamble + '\n' + fragmentChunk + '\n' + shader_epilogue;
            // Create the shader material with Shadertoy-like uniforms
            this.material = new THREE.ShaderMaterial({
                uniforms: {
                    iResolution: { value: new THREE.Vector3(window.innerWidth, window.innerHeight, 1.0) },
                    iTime: { value: 0.0 },
                    iTimeDelta: { value: 0.0 },
                    iFrame: { value: 0 },
                    iMouse: { value: new THREE.Vector4(0, 0, 0, 0) },
                    iChannel0: { value: null },  // This will hold the previous frame
                    iBackgroundTexture: { value: null } // This will hold the background scene render
                },
                vertexShader: vertexShader,
                fragmentShader: fragmentShader
            });
            
            // Create a plane that fills the entire view
            const geometry = new THREE.PlaneGeometry(2, 2);
            this.quad = new THREE.Mesh(geometry, this.material);
            this.scene.add(this.quad);
            
            // Mark as initialized
            this.initialized = true;
            
            // Add mouse event listeners
            this.setupMouseListeners();
        } catch (error) {
            console.error('Error loading shader:', error);
        }
    }
    
    setupMouseListeners() {
        // Handle mouse movement for iMouse uniform
        const onMouseMove = (event) => {
            if (!this.material) return;
            
            const uniforms = this.material.uniforms;
            uniforms.iMouse.value.x = event.clientX;
            uniforms.iMouse.value.y = window.innerHeight - event.clientY; // Invert Y to match Shadertoy
        };
        
        // Handle mouse clicks for iMouse.zw
        const onMouseDown = (event) => {
            if (!this.material) return;
            
            const uniforms = this.material.uniforms;
            uniforms.iMouse.value.z = event.clientX;
            uniforms.iMouse.value.w = window.innerHeight - event.clientY;
        };
        
        const onMouseUp = () => {
            if (!this.material) return;
            
            const uniforms = this.material.uniforms;
            uniforms.iMouse.value.z = 0;
            uniforms.iMouse.value.w = 0;
        };
        
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
    }
    
    anim_frame(dt) {
        if (!this.initialized || !this.material) return;
        
        // Update the shader uniforms
        const uniforms = this.material.uniforms;
        uniforms.iTimeDelta.value = dt;
        uniforms.iTime.value += dt;
        uniforms.iFrame.value += 1;
    }
    
    handle_resize(width, height) {
        if (!this.initialized || !this.material) return;
        
        // Update the resolution uniform
        this.material.uniforms.iResolution.value.set(width, height, 1.0);
        
        // Create render targets with new size
        const rtOptions = {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            stencilBuffer: false
        };
        
        this.renderTarget = new THREE.WebGLRenderTarget(width, height, rtOptions);
        this.prevRender = new THREE.WebGLRenderTarget(width, height, rtOptions);
    }
    
render(renderer, underlying_buffer) {
    if (!this.initialized || !this.material) return;
    
    // Create render targets if not already created
    /*if (!this.renderTarget) {
        this.handle_resize(window.innerWidth, window.innerHeight);
    }*/
    
    // Set the background texture as a uniform so the shader can access it
    this.material.uniforms.iBackgroundTexture.value = underlying_buffer.texture;
    
    //this.material.uniforms.iChannel0.value = this.prevRender.texture;

    // Render to the screen
    renderer.render(this.scene, this.camera);

    //renderer.setRenderTarget(this.renderTarget);
    //renderer.render(this.scene, this.camera);

    // Swap buffers
    /*const temp = this.prevRender;
    this.prevRender = this.renderTarget;
    this.renderTarget = temp;*/
}
}

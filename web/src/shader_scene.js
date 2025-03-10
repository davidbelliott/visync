import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { ResourceLoader } from './util.js';

export class ShaderScene extends VisScene {
    constructor(fragmentShaderUrl) {
        super();
        
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
            const [vertexShader, fragmentShader] = await shaderLoader.load();
            
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
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            stencilBuffer: false
        };
        
        this.renderTarget = new THREE.WebGLRenderTarget(width, height, rtOptions);
        this.backgroundTarget = new THREE.WebGLRenderTarget(width, height, rtOptions);
    }
    
    render(renderer, underlying_buffer) {
        if (!this.initialized || !this.material) return;
        
        // Create render targets if not already created
        if (!this.renderTarget || !this.backgroundTarget) {
            this.handle_resize(window.innerWidth, window.innerHeight);
        }
        
        // Get current render target and clear color
        const currentRenderTarget = renderer.getRenderTarget();
        const currentClearColor = renderer.getClearColor(new THREE.Color());
        const currentClearAlpha = renderer.getClearAlpha();
        
        // Set the background texture as a uniform so the shader can access it
        this.material.uniforms.iBackgroundTexture.value = underlying_buffer.texture;
        
        // Use the render target to capture the current frame for the next frame (for feedback effects)
        renderer.setRenderTarget(this.renderTarget);
        renderer.render(this.scene, this.camera);
        
        // Use the captured frame as input for the next frame
        this.material.uniforms.iChannel0.value = this.renderTarget.texture;
        
        // Render to the screen
        renderer.setRenderTarget(currentRenderTarget);
        renderer.setClearColor(currentClearColor, currentClearAlpha);
        renderer.render(this.scene, this.camera);
    }
    
    // Helper method to integrate with a specific underlying scene
    processUnderlyingScene(underlyingScene, renderer) {
        // First render the underlying scene
        renderer.setRenderTarget(this.backgroundTarget);
        renderer.clear();
        
        // Set the background texture
        this.material.uniforms.iBackgroundTexture.value = this.backgroundTarget.texture;
        
        // Now render our effect
        renderer.setRenderTarget(null);
        renderer.clear();
        this.render(renderer);
    }
}

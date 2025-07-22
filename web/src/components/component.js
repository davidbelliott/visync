import * as THREE from 'three';

export class Component extends THREE.Object3D {
    constructor() {
        super();
    }
    anim_frame(dt) {
        this.children.forEach((child) => {
            if (child.anim_frame) {
                child.anim_frame(dt);
            }
        });
    }

    handle_sync(latency, sync_rate_hz, sync_idx) {
        this.children.forEach((child) => {
            if (child.handle_sync) {
                child.handle_sync(latency, sync_rate_hz, sync_idx);
            }
        });
    }
    
    handle_beat(latency, channel) {
        this.children.forEach((child) => {
            if (child.handle_beat) {
                child.handle_beat(latency, channel);
            }
        });
    }
}

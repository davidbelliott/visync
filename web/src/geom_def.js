import * as THREE from 'three';
import { create_instanced_cube } from './util.js';

export class GeomDef {
    constructor(coords, children=new Map()) {
        this.coords = coords;
        this.children = children;
        this.mesh = null;
    }

    create() {
        const group = new THREE.Group();
        for (const [i, c] of this.children) {
            group.add(c.create());
        }
        this.mesh = group;
        this.mesh.position.set(...this.coords);
        return this.mesh;
    }
}

export class BoxDef extends GeomDef {
    constructor(coords, dims, color="yellow", children=new Map()) {
        super(coords, children);
        this.dims = dims;
        this.color = color;
    }
    create() {
        super.create();
        const created_mesh = create_instanced_cube(this.dims, this.color);
        /*let geometry = new THREE.BoxGeometry(...this.dims);
        let wireframe = new THREE.EdgesGeometry(geometry);
        const wireframe_mat = new THREE.LineBasicMaterial( { color: "yellow", linewidth: 1 } );
        this.mesh.add(new THREE.LineSegments(wireframe, wireframe_mat));

        const inner_dims = [...this.dims];
        for (const i in inner_dims) {
            inner_dims[i] *= 0.97;
        }
        const fill_mat = new THREE.MeshBasicMaterial( { color: "black" } );
        const inner_geom = new THREE.BoxGeometry(...inner_dims);
        this.mesh.add(new THREE.Mesh(inner_geom, fill_mat));*/
        this.mesh.add(created_mesh);
        return this.mesh;
    }
}


export class LineDef extends GeomDef {
    constructor(coords, children=new Map()) {
        super(coords, children);
        this.coords = coords;
    }
    create() {
        super.create();
        const line_mat = new THREE.LineBasicMaterial({color: "yellow"});
        const points = [];
        for (const i in this.coords) {
            points.push(new THREE.Vector3(...(this.coords[i])));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geom, line_mat);
        this.mesh.add(line);
        return this.mesh;
    }
}

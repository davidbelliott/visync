import * as THREE from 'three';
import { Scene } from './scene.js';

// Mirrors kinect_control.py's POSE_CONNECTIONS (MediaPipe Pose's 33-landmark
// skeleton edges) so this draws the same joints as the adapter's debug window.
const POSE_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
    [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
    [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
    [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

const NUM_LANDMARKS = 33;

// Matches kinect_control.py's MAX_PEOPLE; a MsgPose with more skeletons than
// this just has the extras silently dropped (see handle_pose).
const MAX_SKELETONS = 4;

// MsgPose landmarks arrive in metres (person-scale, ~1.7m tall); scaled up
// to read as a normal-sized object against this scene's camera.
const POSE_SCALE = 5;
const JOINT_RADIUS = 0.01 * POSE_SCALE;

// Hide the skeletons if this many seconds pass with no new MsgPose -- tight
// enough to disappear promptly once tracking is lost (everyone steps out of
// frame, Kinect disconnects), loose enough to ride out an occasional
// dropped detection without flickering.
const POSE_STALE_TIMEOUT_S = 0.5;

export class PoseScene extends Scene {
    constructor(context) {
        super(context, 'pose');

        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 12;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        // Plain front-on view rather than the usual isometric tilt: the
        // point is recognizing tracked poses, which a stylized tilt would
        // work against.
        this.camera = this.cam_orth;

        this.clear();
        this.base_group = new THREE.Group();
        this.add(this.base_group);

        // Lights every skeleton's filled sphere joints; harmless if this
        // scene ever ends up composited behind another (lights only affect
        // objects in the same THREE.Scene).
        this.light = new THREE.PointLight("white", 500, 100, 1.5);
        this.light.position.set(0, 0, 30);
        this.base_group.add(this.light);

        // One independent lines+joints pair per potential person, built up
        // front and toggled visible/hidden per handle_pose call rather than
        // created/destroyed per message.
        this.skeletons = [];
        for (let s = 0; s < MAX_SKELETONS; s++) {
            this.skeletons.push(this.create_skeleton());
        }

        // No pose received yet.
        this.last_pose_time = null;

        // Knob CH_ZOOM scales the camera zoom (see Scene.bind_zoom).
        this.bind_zoom();
    }

    // Builds one person's worth of drawable skeleton (lines + joints), all
    // added to base_group and initially hidden. depthTest/depthWrite off on
    // both materials: this scene composites over whatever else is drawn
    // that frame (see GraphicsContext.render), and without this the
    // skeleton could be partly hidden by leftover depth-buffer values from
    // an earlier-drawn scene, since depth isn't cleared between scenes.
    create_skeleton() {
        // Skeleton lines: one preallocated LineSegments over every edge (two
        // vertices each), positions rewritten in place per handle_pose call
        // instead of rebuilding the geometry.
        const line_positions = new Float32Array(POSE_CONNECTIONS.length * 2 * 3);
        const line_geom = new THREE.BufferGeometry();
        line_geom.setAttribute('position', new THREE.BufferAttribute(line_positions, 3));
        const line_attr = line_geom.attributes.position;
        const skeleton_lines = new THREE.LineSegments(
            line_geom, new THREE.LineBasicMaterial({
                color: 'orange', linewidth: 2, depthTest: false, depthWrite: false }));
        // The buffer starts at the origin for every vertex; bounds computed
        // from that would clip the real (updated) skeleton once it moves.
        skeleton_lines.frustumCulled = false;
        skeleton_lines.renderOrder = 999;
        skeleton_lines.visible = false;
        this.base_group.add(skeleton_lines);

        // Joint markers: solid shaded spheres, one InstancedMesh draw call
        // for all 33 landmarks, instance transforms rewritten per
        // handle_pose call.
        const joint_geom = new THREE.SphereGeometry(JOINT_RADIUS, 12, 8);
        const joint_mat = new THREE.MeshLambertMaterial({
            color: 'orange', depthTest: false, depthWrite: false });
        const joints = new THREE.InstancedMesh(joint_geom, joint_mat, NUM_LANDMARKS);
        joints.frustumCulled = false;
        joints.renderOrder = 999;
        joints.visible = false;
        this.base_group.add(joints);

        return { skeleton_lines, line_attr, joints, joint_matrix: new THREE.Matrix4() };
    }

    // skeletons: array of skeletons, one per detected person (see
    // adapter/message.py's MsgPose), each an array of 33 [x, y, z]
    // world-space points in metres, MediaPipe's convention: origin at the
    // hip centre, x right, y DOWN, z toward the camera. y is flipped below
    // for this scene's Y-up convention so skeletons stand upright.
    handle_pose(skeletons) {
        if (!skeletons || skeletons.length === 0) {
            return;
        }
        this.last_pose_time = performance.now();

        const count = Math.min(skeletons.length, this.skeletons.length);
        for (let s = 0; s < count; s++) {
            const landmarks = skeletons[s];
            const drawable = this.skeletons[s];
            if (!landmarks || landmarks.length < NUM_LANDMARKS) {
                drawable.skeleton_lines.visible = false;
                drawable.joints.visible = false;
                continue;
            }

            for (let i = 0; i < NUM_LANDMARKS; i++) {
                const [x, y, z] = landmarks[i];
                drawable.joint_matrix.makeTranslation(
                    x * POSE_SCALE, -y * POSE_SCALE, z * POSE_SCALE);
                drawable.joints.setMatrixAt(i, drawable.joint_matrix);
            }
            drawable.joints.instanceMatrix.needsUpdate = true;

            for (let e = 0; e < POSE_CONNECTIONS.length; e++) {
                const [a, b] = POSE_CONNECTIONS[e];
                const [ax, ay, az] = landmarks[a];
                const [bx, by, bz] = landmarks[b];
                drawable.line_attr.setXYZ(e * 2, ax * POSE_SCALE, -ay * POSE_SCALE, az * POSE_SCALE);
                drawable.line_attr.setXYZ(e * 2 + 1, bx * POSE_SCALE, -by * POSE_SCALE, bz * POSE_SCALE);
            }
            drawable.line_attr.needsUpdate = true;

            drawable.skeleton_lines.visible = true;
            drawable.joints.visible = true;
        }

        // Fewer people than last message: hide whichever slots are no
        // longer occupied.
        for (let s = count; s < this.skeletons.length; s++) {
            this.skeletons[s].skeleton_lines.visible = false;
            this.skeletons[s].joints.visible = false;
        }
    }

    anim_frame(dt) {
        super.anim_frame(dt);
        // Hide once the last pose goes stale -- handle_pose only sets
        // visible = true, so this is the only place that turns it back off.
        const stale = this.last_pose_time === null ||
            (performance.now() - this.last_pose_time) / 1000 > POSE_STALE_TIMEOUT_S;
        if (stale) {
            for (const drawable of this.skeletons) {
                drawable.skeleton_lines.visible = false;
                drawable.joints.visible = false;
            }
        }
    }
}

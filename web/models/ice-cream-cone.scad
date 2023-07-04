$fn = 20;
rotate_extrude(convexity=10) {
        difference() {
            circle(r=6);
            translate([-6, 0, 0]) square(12, center=true);
        }
        polygon([[0, 0], [0, -20], [6, 0]]);
        translate([5, -2, 0]) circle(1.5);
}
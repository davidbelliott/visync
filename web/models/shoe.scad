
    translate([100, 100, -50])
    rotate([90, 0, 0])
    linear_extrude(200) {
        polygon(points=[[0,0],[100,0],[0,100]],convexity=2);
        
        translate([-200, 0, 0]) square([200, 100]);
    }
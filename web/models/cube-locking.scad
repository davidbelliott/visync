$fn=64;
union() {
    for(i = [0 : 2] ) {
        
        for(j = [0 : 2] ) {

            for (k = [0 : 2] ) {
                translate([8 * (i - 1), 8 * (j - 1), 8 * (k - 1)]) {
                    
                    if ((i + j + k) % 2 == 0) {
                            difference() {
                                cube(8, center=true);
                                cylinder(10, 3, 3, center=true);
                                rotate([90, 0, 0]) cylinder(10, 3, 3, center=true);
                                rotate([0, 90, 0]) cylinder(10, 3, 3, center=true);
                            }
                    }
                }
            }
        }
    }
}
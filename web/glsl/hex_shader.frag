uniform vec3      resolution;           // viewport resolution (in pixels)
uniform float time;

//#define FLAT_TOP_HEXAGON

// Helper vector. If you're doing anything that involves regular triangles or hexagons, the
// 30-60-90 triangle will be involved in some way, which has sides of 1, sqrt(3) and 2.
#ifdef FLAT_TOP_HEXAGON
const vec2 s = vec2(1.7320508, 1);
#else
const vec2 s = vec2(1, 1.7320508);
#endif

#define PI 3.1415927

float random (in vec2 st) {
    return fract(sin(dot(st.xy,
                         vec2(12.9898,78.233)))
                 * 43758.5453123);
}

float hash21(vec2 p)
{
    return fract(sin(dot(p, vec2(141.13, 289.97)))*43758.5453);
}

// The 2D hexagonal isosuface function: If you were to render a horizontal line and one that
// slopes at 60 degrees, mirror, then combine them, you'd arrive at the following. As an aside,
// the function is a bound -- as opposed to a Euclidean distance representation, but either
// way, the result is hexagonal boundary lines.
float hex(in vec2 p)
{    
    p = abs(p);
    
    #ifdef FLAT_TOP_HEXAGON
    return max(dot(p, s*.5), p.y); // Hexagon.
    #else
    return max(dot(p, s*.5), p.x); // Hexagon.
    #endif    
}

vec3 rainbow(float level)
{
	/*
		Target colors
		=============

		L  x   color
		0  0.0 vec4(1.0, 0.0, 0.0, 1.0);
		1  0.2 vec4(1.0, 0.5, 0.0, 1.0);
		2  0.4 vec4(1.0, 1.0, 0.0, 1.0);
		3  0.6 vec4(0.0, 0.5, 0.0, 1.0);
		4  0.8 vec4(0.0, 0.0, 1.0, 1.0);
		5  1.0 vec4(0.5, 0.0, 0.5, 1.0);
	*/

	float r = float(level <= 2.0) + float(level > 4.0) * 0.5;
	float g = max(1.0 - abs(level - 2.0) * 0.5, 0.0);
	float b = (1.0 - (level - 4.0) * 0.5) * float(level >= 4.0);
	return vec3(r, g, b);
}

// This function returns the hexagonal grid coordinate for the grid cell, and the corresponding 
// hexagon cell ID -- in the form of the central hexagonal point. That's basically all you need to 
// produce a hexagonal grid.
//
// When working with 2D, I guess it's not that important to streamline this particular function.
// However, if you need to raymarch a hexagonal grid, the number of operations tend to matter.
// This one has minimal setup, one "floor" call, a couple of "dot" calls, a ternary operator, etc.
// To use it to raymarch, you'd have to double up on everything -- in order to deal with 
// overlapping fields from neighboring cells, so the fewer operations the better.
vec4 getHex(vec2 p)
{    
    // The hexagon centers: Two sets of repeat hexagons are required to fill in the space, and
    // the two sets are stored in a "vec4" in order to group some calculations together. The hexagon
    // center we'll eventually use will depend upon which is closest to the current point. Since 
    // the central hexagon point is unique, it doubles as the unique hexagon ID.
    
    #ifdef FLAT_TOP_HEXAGON
    vec4 hC = floor(vec4(p, p - vec2(1, .5))/s.xyxy) + .5;
    #else
    vec4 hC = floor(vec4(p, p - vec2(.5, 1))/s.xyxy) + .5;
    #endif
    
    // Centering the coordinates with the hexagon centers above.
    vec4 h = vec4(p - hC.xy*s, p - (hC.zw + .5)*s);
    
    
    // Nearest hexagon center (with respect to p) to the current point. In other words, when
    // "h.xy" is zero, we're at the center. We're also returning the corresponding hexagon ID -
    // in the form of the hexagonal central point.
    //
    // On a side note, I sometimes compare hex distances, but I noticed that Iomateron compared
    // the squared Euclidian version, which seems neater, so I've adopted that.
    return dot(h.xy, h.xy) < dot(h.zw, h.zw) 
        ? vec4(h.xy, hC.xy) 
        : vec4(h.zw, hC.zw + .5);
}

vec3 hsb2rgb( in vec3 c ){
    vec3 rgb = clamp(abs(mod(c.x*6.0+vec3(0.0,4.0,2.0),
                             6.0)-3.0)-1.0,
                     0.0,
                     1.0 );
    rgb = rgb*rgb*(3.0-2.0*rgb);
    return c.z * mix( vec3(1.0), rgb, c.y);
}

float noise (in vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);

    // Four corners in 2D of a tile
    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));

    // Smooth Interpolation

    // Cubic Hermine Curve.  Same as SmoothStep()
    vec2 u = f*f*(3.0-2.0*f);
    // u = smoothstep(0.,1.,f);

    // Mix 4 coorners percentages
    return mix(a, b, u.x) +
            (c - a)* u.y * (1.0 - u.x) +
            (d - b) * u.x * u.y;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    // Aspect correct screen coordinates.
    float hex_size = 40.;// + 10. * sin(time * PI / 2.0);
    //vec2 u = (fragCoord - resolution.xy / 2.0 + 0.5) / hex_size;

    vec2 st = fragCoord.xy / resolution.xy;
    vec2 to_center = vec2(0.5) - st;
    
    vec2 u = (fragCoord - resolution.xy / 2.0 + 0.5);
    float radius_px = length(u);

    float y_noise = noise(to_center * 1.0 + time * PI);
    float x_noise = noise(to_center * 1.0 + time * PI / 2.0);
    float theta = atan(u.y * (1.0 + 0.2 * y_noise), u.x * (1.0 + 0.5 * x_noise)) + time * PI / 8.0;
    u = vec2(cos(theta), sin(theta)) * radius_px / hex_size;

    // Scaling, translating, then converting it to a hexagonal grid cell coordinate and
    // a unique coordinate ID. The resultant vector contains everything you need to produce a
    // pretty pattern, so what you do from here is up to you.
    //vec4 h = getHex(u*10. + s.yx*time/2.);
    //vec4 h = getHex(u + time);
    //vec4 h = getHex(u + s.yx * time * 2.0);
    vec4 h = getHex(u);
    //float width = 4.0 + 3.0 * sin(time * PI * 8.0);
    float width = 1.0;
    
    // The beauty of working with hexagonal centers is that the relative edge distance will simply 
    // be the value of the 2D isofield for a hexagon.
    float eDist = hex(h.xy); // Edge distance.

    float radius = length(to_center);

    radius += noise(to_center * 5.0) * time * PI * 0.5);
    float alpha = 0.5 * noise(to_center * 1.0 + time * PI);
    vec3 rainbow_color = hsb2rgb(vec3(
                mod(radius * 2.0 - time * 2.0, 1.), 1.0, 1.0));
    fragColor = mix(vec4(0), vec4(rainbow_color.xyz, alpha), step(0., (eDist - .5) * hex_size + width / 2.));    
    //fragColor.a *= sin(time * 2. * PI);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}


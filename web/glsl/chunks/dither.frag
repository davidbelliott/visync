gl_FragColor.rgb = dither4x4(gl_FragCoord.xy, gl_FragColor.rgb) * 2.0;

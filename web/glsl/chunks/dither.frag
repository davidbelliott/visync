gl_FragColor.rgb = dither4x4(gl_FragCoord.xy / 2.0, gl_FragColor.rgb) * 2.0;

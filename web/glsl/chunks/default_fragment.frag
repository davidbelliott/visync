void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  gl_FragColor = texture2D(iBackgroundTexture, fragCoord);
}

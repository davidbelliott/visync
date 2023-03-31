function projectNDimensionalCube(n, vertices, projectionType) {
  // Generate the rotation matrix for n-dimensional space
  function generateRotationMatrix(n, angle) {
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    const rotationMatrix = [];

    for (let i = 0; i < n; i++) {
      rotationMatrix[i] = Array(n).fill(0);
      rotationMatrix[i][i] = 1;
    }

    for (let i = 0; i < n - 1; i++) {
      rotationMatrix[i][i] = cosAngle;
      rotationMatrix[i][i + 1] = -sinAngle;
      rotationMatrix[i + 1][i] = sinAngle;
      rotationMatrix[i + 1][i + 1] = cosAngle;
    }

    return rotationMatrix;
  }

  // Apply a matrix transformation to a vertex
  function applyMatrix(vertex, matrix) {
    const result = [];

    for (let i = 0; i < matrix.length; i++) {
      let sum = 0;
      for (let j = 0; j < vertex.length; j++) {
        sum += matrix[i][j] * vertex[j];
      }
      result.push(sum);
    }

    return result;
  }

  // Project an n-dimensional vertex to 3D
  function projectVertex(vertex, projectionType) {
    const w = vertex[vertex.length - 1];
    const factor = projectionType === "perspective" ? 1 / (1 + w) : 1;

    return [
      vertex[0] * factor,
      vertex[1] * factor,
      vertex[2] * factor,
    ];
  }

  // Create a rotation matrix and apply it to all vertices
  const angle = 0.1;
  const rotationMatrix = generateRotationMatrix(n, angle);
  const rotatedVertices = vertices.map((vertex) => applyMatrix(vertex, rotationMatrix));

  // Project n-dimensional vertices to 3D
  return rotatedVertices.map((vertex) => projectVertex(vertex, projectionType));
}

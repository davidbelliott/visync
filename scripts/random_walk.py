import json
from PIL import Image, ImageDraw

class Vec2:
   def __init__(self, x, y):
       self.x = x
       self.y = y

   def __add__(self, other):
       return Vec2(self.x + other.x, self.y + other.y)

   def __sub__(self, other):
       return Vec2(self.x - other.x, self.y - other.y)

   def __neg__(self):
       return Vec2(-self.x, -self.y)

   def __mul__(self, scalar):
       return Vec2(self.x * scalar, self.y * scalar)

   def __repr__(self):
       return f'({self.x}, {self.y})'

   def __eq__(self, other):
       return self.x == other.x and self.y == other.y

fwd_moves = [Vec2(*v) for v in [[1, 0], [-1, 0], [0, 1], [0, -1]]]

def in_bounds(pos, grid_dims):
   return pos.x >= 0 and pos.y >= 0 and pos.x <= grid_dims.x and pos.y <= grid_dims.y

def symmetric_random_walk(moves_to_here, cursor_positions, grid_dims):
   found_walks = []
   for move in range(0, 4):
       new_pos = cursor_positions[-1] + fwd_moves[move]
       new_inv_pos = grid_dims - new_pos
       if in_bounds(new_pos, grid_dims) \
               and (new_pos not in cursor_positions) \
               and (new_inv_pos not in cursor_positions[:-1]):
           if new_inv_pos == cursor_positions[-1]:
               # New move closes the walk symmetrically
               found_walks.append(moves_to_here + [move])
           else:
               # Continue searching from here
               found_walks += symmetric_random_walk(moves_to_here + [move], cursor_positions + [new_pos], grid_dims)

   return found_walks


def convert_walk_to_coords(walk, pixel_scale):
   # Start at (0, 0) and build the list of global coordinates
   coords = [(0, 0)]
   current_pos = Vec2(0, 0)
   for move in walk:
       current_pos = current_pos + fwd_moves[move] * pixel_scale
       coords.append((current_pos.x, current_pos.y))
   for move in walk[-2::-1]:
       current_pos = current_pos + fwd_moves[move] * pixel_scale
       coords.append((current_pos.x, current_pos.y))
   return coords


def walks_to_png(found_walks, grid_scale, line_width, margin, grid_dims, png_filename):
   walks_per_row = 16
   num_rows = 1 + (len(found_walks) - 1) // walks_per_row
   img_size = Vec2(walks_per_row * (grid_dims.x * grid_scale + margin),
                   num_rows * (grid_dims.y * grid_scale + margin))

   # Create a blank canvas
   img = Image.new('RGB', (img_size.x, img_size.y), color='black')
   draw = ImageDraw.Draw(img)

   # Iterate through each walk and plot
   for i, walk in enumerate(found_walks):
       # Get local coords
       coords = convert_walk_to_coords(walk, grid_scale)
       # Convert to world coords
       coords = [(margin / 2 + x + (i % walks_per_row) * (grid_dims.x * grid_scale + margin),
                  margin / 2 + y + (i // walks_per_row) * (grid_dims.y * grid_scale + margin)) for x, y in coords]

       x_vals, y_vals = zip(*coords)
       draw.line(coords, fill='white', width=line_width)

   # Save as PNG
   img.save(png_filename)


def walks_to_json(found_walks, grid_scale, margin, grid_dims, json_filename):
   walks_per_row = 16
   num_rows = 1 + (len(found_walks) - 1) // walks_per_row

   walks_data = []
   for i, walk in enumerate(found_walks):
       # Get local coords
       coords = convert_walk_to_coords(walk, grid_scale)
       # Convert to world coords
       coords = [(x + (i % walks_per_row) * (grid_dims.x * grid_scale + margin),
                  y + (i // walks_per_row) * (grid_dims.y * grid_scale + margin)) for x, y in coords]
       walks_data.append(coords)

   with open(json_filename, 'w') as f:
       json.dump(walks_data, f)


if __name__ == "__main__":
   grid_dims = Vec2(5, 4)
   found_walks = symmetric_random_walk([], [Vec2(0, 0)], grid_dims)
   print(len(found_walks))
   walks_to_png(found_walks, 2, 1, 4, grid_dims, 'out.png')

   walks_to_json(found_walks, 1, 2, grid_dims, 'out.json')

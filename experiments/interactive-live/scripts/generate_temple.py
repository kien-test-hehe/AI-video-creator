"""Generate an original, low-poly temple GLB using Blender. No external assets."""
import math
import pathlib
import sys
import bpy

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

def material(name, rgba, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgba, 1)
    mat.use_nodes = True
    p = mat.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*rgba, 1)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = 0.65
    return mat

stone = material("warm-stone", (0.52, 0.54, 0.49))
wood = material("dark-red-wood", (0.28, 0.11, 0.085))
gold = material("gold-brass", (0.77, 0.54, 0.20), 0.5)
roof_mat = material("jade-roof", (0.035, 0.20, 0.21))
plaster = material("cream-wall", (0.68, 0.62, 0.49))
door = material("dark-entry", (0.025, 0.035, 0.05))

def cube(name, pos, size, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj

def cylinder(name, pos, radius, depth, mat, vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj

def roof(name, z, radius, depth):
    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=radius, radius2=0.0, depth=depth, location=(0, 0, z))
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler.z = math.pi / 4
    obj.data.materials.append(roof_mat)

cube("foundation", (0, 0, 0.25), (16, 9.5, 0.5), stone)
cube("main-hall", (0, 0, 3.0), (13.2, 7.3, 4.9), plaster)
cube("front-beam", (0, 3.55, 5.55), (14.8, 0.75, 0.65), gold)
for i in range(4):
    x = [-5.8, -2.5, 2.5, 5.8][i]
    cylinder("veranda-column-%d" % i, (x, 3.72, 3.05), 0.28, 4.8, wood)
    cylinder("column-cap-%d" % i, (x, 3.72, 5.45), 0.42, 0.24, gold)
cube("doorway", (0, 3.7, 2.65), (2.9, 0.16, 4.1), door)
for i in range(5):
    cube("stairs-%d" % i, (0, 5.3 + i * 0.6, 0.04 - i * 0.12), (9.5 - i * 0.6, 0.65, 0.25), stone)
cube("lower-roof-trim", (0, 0, 5.85), (15.8, 9.2, 0.35), gold)
roof("wide-jade-roof", 7.0, 9.3, 2.6)
cube("upper-roof-platform", (0, 0, 8.45), (10.1, 6.3, 0.32), gold)
roof("upper-jade-roof", 9.65, 6.2, 2.35)
cylinder("spire", (0, 0, 11.15), 0.24, 1.3, gold)
cylinder("spire-crown", (0, 0, 11.86), 0.40, 0.20, gold)

# glTF uses Y-up in consumers such as Three.js. Blender exports the coordinate transform.
output = pathlib.Path(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else pathlib.Path("public/models/temple.glb")
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output.resolve()), export_format="GLB", export_yup=True)
print("Created original procedural GLB:", output)

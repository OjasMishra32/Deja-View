-- Object layout contract test. Run from roblox/:  lune run tests/object_layout_test.luau
local ObjectLayout = require("../src/shared/ObjectLayout")

local failures = 0
local function check(name: string, ok: boolean, detail: string?)
	if ok then
		print(`PASS  {name}`)
	else
		failures += 1
		print(`FAIL  {name}  {detail or ""}`)
	end
end

local function near(a: number, b: number, eps: number?): boolean
	return math.abs(a - b) <= (eps or 1e-6)
end

local doc = {
	version = 1,
	sceneId = "kitchen",
	units = "studs",
	studsPerMeter = 3.57,
	style = "flat",
	objects = {
		{
			id = "fridge",
			label = "fridge",
			confidence = 0.94,
			center = { 10, 20, -30 },
			size = { 2.6, 9.2, 2.4 },
			color = { 242, 242, 238 },
			parts = {
				{
					name = "handle",
					shape = "cylinder",
					center = { 10, 24, -28.8 },
					size = { 0.18, 2.0, 0.18 },
					color = { 44, 44, 48 },
				},
			},
			affordance = { kind = "door", hinge = "left", openAngle = 100 },
			assetId = 1234567890,
		},
		{ id = "counter", label = "counter", center = { -4, 10, -30 }, size = { 8, 4, 3 }, color = { 180, 140, 100 } },
	},
}

local p = ObjectLayout.plan(doc)
check("scene id is carried", p.sceneId == "kitchen")
check("two objects are planned", #p.objects == 2)
check("object order is stable", p.objects[1].id == "fridge" and p.objects[2].id == "counter")
check("center is copied in studs", p.objects[1].center[2] == 20)
check("size is inflated to cover the scan", near(p.objects[1].size[1], 2.7), `size={p.objects[1].size[1]}`)
check("colour comes from the object", p.objects[1].color[1] == 242)
check("child parts are planned", #p.objects[1].parts == 1)
check("child shape is kept", p.objects[1].parts[1].shape == "cylinder")
check("child colour is kept", p.objects[1].parts[1].color[1] == 44)
check("affordance is kept", p.objects[1].affordance.kind == "door")
check("uploaded mesh id is kept", p.objects[1].assetId == 1234567890)
check("flat style has no outline", p.outline == false)
check("flat style keeps the scanned colour", p.objects[1].color[1] == 242 and p.objects[1].color[3] == 238)
check("flat style keeps the second object colour", p.objects[2].color[1] == 180 and p.objects[2].color[3] == 100)

local dark = ObjectLayout.plan(doc, { style = "dark" })
check("dark style tints the body", dark.objects[2].color[1] < 180, `r={dark.objects[2].color[1]}`)
local retro = ObjectLayout.plan(doc, { style = "retro" })
check("retro style quantizes to four levels", retro.objects[1].color[1] == 255, `r={retro.objects[1].color[1]}`)
local cartoon = ObjectLayout.plan(doc, { style = "cartoon" })
check("cartoon style asks for an outline", cartoon.outline == true)
local quiet = ObjectLayout.plan(doc, { minConfidence = 0.95 })
check("low-confidence objects can be skipped", #quiet.objects == 1, `n={#quiet.objects}`)
local none = ObjectLayout.plan({ sceneId = "empty", units = "studs", objects = {} })
check("an empty document is empty", #none.objects == 0)

local okUnits = pcall(function()
	ObjectLayout.plan({ units = "metres", objects = {} })
end)
check("non-stud units are rejected", okUnits == false)
local okSize = pcall(function()
	ObjectLayout.plan({ units = "studs", objects = { { id = "bad" } } })
end)
check("a missing size is rejected", okSize == false)
local okStyle = pcall(function()
	ObjectLayout.plan({ units = "studs", objects = {} }, { style = "nope" })
end)
check("an unknown style is rejected", okStyle == false)

print(`\n{if failures == 0 then "ALL PASS" else "FAILURES"}  ({failures} failure(s))`)
if failures > 0 then
	error(`object layout failures: {failures}`)
end

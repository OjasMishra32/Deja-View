-- Turns an `objects.json` document into renderer-neutral part plans.
-- The server builds Instances from these plans; the test runs under Lune with no Roblox services.
-- Contract: docs/object-layer.md section 6. Units are studs in the room frame.
local ObjectLayout = {}

ObjectLayout.VERSION = 1
ObjectLayout.DEFAULT_INFLATE = 0.05 -- studs; covers the rough scanned original

ObjectLayout.STYLES = {
	-- flat keeps the object's own body colour: the scan already knows a fridge is stainless,
	-- not white. A label palette belongs to a deliberate theme, not the default style.
	flat = { bodyTint = { 255, 255, 255 }, outline = false },
	cartoon = { bodyTint = { 255, 255, 255 }, outline = true },
	retro = { bodyTint = { 255, 255, 255 }, outline = false, quantize = 4 },
	dark = { bodyTint = { 70, 72, 82 }, outline = false },
}

local function clampByte(v: number): number
	return math.clamp(math.floor(v + 0.5), 0, 255)
end

local function color(c: any, fallback: { number }): { number }
	if typeof(c) ~= "table" or #c < 3 then
		return { fallback[1], fallback[2], fallback[3] }
	end
	return { clampByte(c[1]), clampByte(c[2]), clampByte(c[3]) }
end

local function styleColor(rgb: { number }, style: any): { number }
	local tint = style.bodyTint or { 255, 255, 255 }
	local out = {
		clampByte(rgb[1] * tint[1] / 255),
		clampByte(rgb[2] * tint[2] / 255),
		clampByte(rgb[3] * tint[3] / 255),
	}
	if style.quantize then
		local step = 255 / (style.quantize - 1)
		for i = 1, 3 do
			out[i] = clampByte(math.floor(out[i] / step + 0.5) * step)
		end
	end
	return out
end

local function vec3(v: any, name: string): { number }
	if typeof(v) ~= "table" or #v < 3 then
		error(`objects: {name} must be [x, y, z]`, 3)
	end
	return { tonumber(v[1]) or 0, tonumber(v[2]) or 0, tonumber(v[3]) or 0 }
end

local function inflate(size: { number }, by: number): { number }
	local out = {}
	for i = 1, 3 do
		out[i] = math.max(0.05, size[i] + by * 2)
	end
	return out
end

function ObjectLayout.plan(doc: any, opts: any?): any
	opts = opts or {}
	if typeof(doc) ~= "table" then
		error("objects: document must be a table", 2)
	end
	if doc.units ~= nil and doc.units ~= "studs" then
		error(`objects: units must be "studs", got {tostring(doc.units)}`, 2)
	end
	local styleName = opts.style or doc.style or "flat"
	local style = ObjectLayout.STYLES[styleName]
	if not style then
		error(`objects: unknown style {tostring(styleName)}`, 2)
	end
	local by = opts.inflate == nil and ObjectLayout.DEFAULT_INFLATE or opts.inflate
	local minConfidence = opts.minConfidence or 0
	local objects = doc.objects or {}
	if typeof(objects) ~= "table" then
		error("objects: objects must be an array", 2)
	end

	local plans = {}
	for index, obj in objects do
		if typeof(obj) ~= "table" then
			error(`objects[{index}] must be a table`, 2)
		end
		if (obj.confidence or 1) >= minConfidence then
			local id = obj.id or obj.label or `object-{index}`
			local size = inflate(vec3(obj.size, `objects[{index}].size`), by)
			local parts = {}
			for partIndex, part in (obj.parts or {}) do
				if typeof(part) ~= "table" then
					error(`objects[{index}].parts[{partIndex}] must be a table`, 2)
				end
				table.insert(parts, {
					name = part.name or `part-{partIndex}`,
					shape = part.shape or "box",
					center = vec3(part.center, `objects[{index}].parts[{partIndex}].center`),
					size = inflate(vec3(part.size, `objects[{index}].parts[{partIndex}].size`), by * 0.5),
					color = styleColor(color(part.color, { 60, 60, 64 }), style),
				})
			end
			table.insert(plans, {
				id = id,
				label = obj.label or id,
				shape = obj.shape or "box",
				center = vec3(obj.center, `objects[{index}].center`),
				size = size,
				yaw = tonumber(obj.yaw) or 0,
				color = styleColor(color(obj.color, { 240, 240, 240 }), style),
				transparency = obj.transparency or 0,
				parts = parts,
				affordance = obj.affordance,
				source = obj.source,
				assetId = obj.assetId,
			})
		end
	end

	return {
		version = ObjectLayout.VERSION,
		sceneId = doc.sceneId,
		style = styleName,
		outline = style.outline == true,
		objects = plans,
	}
end

return ObjectLayout

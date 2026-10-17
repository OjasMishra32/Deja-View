-- Small helpers shared by server and clients.
local Util = {}

-- Accept [x, y, z] or {x =, y =, z =}; nil if missing.
function Util.vec(v: any): Vector3?
	if type(v) ~= "table" then
		return nil
	end
	local x, y, z = v[1] or v.x, v[2] or v.y, v[3] or v.z
	if type(x) ~= "number" or type(y) ~= "number" or type(z) ~= "number" then
		return nil
	end
	return Vector3.new(x, y, z)
end

function Util.lerpAngle(a: number, b: number, t: number): number
	local d = (b - a + math.pi) % (2 * math.pi) - math.pi
	return a + d * t
end

-- Character -> yaw (0 faces -Z, positive turns left).
function Util.yawOf(cf: CFrame): number
	local look = cf.LookVector
	return math.atan2(-look.X, -look.Z)
end

function Util.feetOf(character: Model): Vector3?
	local hrp = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	local hum = character:FindFirstChildOfClass("Humanoid")
	if not hrp or not hum then
		return nil
	end
	local p = hrp.Position
	return Vector3.new(p.X, p.Y - (hum.HipHeight + hrp.Size.Y / 2), p.Z)
end

function Util.ageText(createdAt: string?): string
	if not createdAt then
		return ""
	end
	local ok, dt = pcall(DateTime.fromIsoDate, createdAt)
	if not ok or not dt then
		return ""
	end
	local secs = DateTime.now().UnixTimestamp - dt.UnixTimestamp
	if secs < 60 then
		return "just now"
	elseif secs < 3600 then
		return math.floor(secs / 60) .. " min ago"
	elseif secs < 86400 then
		return math.floor(secs / 3600) .. " h ago"
	end
	return math.floor(secs / 86400) .. " d ago"
end

function Util.commas(n: number): string
	local s = tostring(math.floor(n))
	local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
	return (out:gsub("^,", ""))
end

return Util

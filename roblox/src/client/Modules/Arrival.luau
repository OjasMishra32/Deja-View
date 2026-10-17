-- The room assembles around you (team/shivin.md Update 9, item 3): when a textured room model arrives, its chunks rise
-- from below and slot into place over about 2 s, nearest first, with a soft sound. Purely local; the server's parts
-- are only moved on this client, and end exactly where the server put them.
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Effects = require(script.Parent.Effects)

local Arrival = {}

local DURATION = 0.9 -- each chunk's rise
local SPREAD = 1.3 -- the last chunk starts this long after the first
local DROP = 18 -- studs below its place a chunk starts

local function ease(a: number): number
	-- ease out back: a small overshoot as each piece slots in
	local c1, c3 = 1.4, 2.4
	return 1 + c3 * (a - 1) ^ 3 + c1 * (a - 1) ^ 2
end

function Arrival.play(model: Instance)
	local parts = {}
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(parts, d)
		end
	end
	if #parts == 0 or #parts > 400 then
		return -- a model this big would cost more than it shows
	end
	local char = Players.LocalPlayer.Character
	local root = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
	local origin = if root then root.Position else Vector3.zero
	table.sort(parts, function(a, b)
		return (a.Position - origin).Magnitude < (b.Position - origin).Magnitude
	end)
	local jobs = {}
	for i, p in parts do
		local target = p.CFrame
		local delay = if #parts > 1 then (i - 1) / (#parts - 1) * SPREAD else 0
		table.insert(jobs, { part = p, target = target, start = os.clock() + delay })
		p.CFrame = target - Vector3.new(0, DROP, 0)
		p.LocalTransparencyModifier = 1
	end
	Effects.sound("tick")
	local conn
	conn = RunService.RenderStepped:Connect(function()
		local done = true
		local now = os.clock()
		for _, j in jobs do
			if not j.part.Parent then
				continue
			end
			local a = math.clamp((now - j.start) / DURATION, 0, 1)
			if a < 1 then
				done = false
			end
			local e = if a <= 0 then 0 else ease(a)
			j.part.CFrame = j.target - Vector3.new(0, DROP * (1 - e), 0)
			j.part.LocalTransparencyModifier = 1 - math.clamp(a * 2.5, 0, 1)
		end
		if done then
			conn:Disconnect()
			for _, j in jobs do
				if j.part.Parent then
					j.part.CFrame = j.target
					j.part.LocalTransparencyModifier = 0
				end
			end
			Effects.sound("win")
		end
	end)
end

-- Watches for each new room's model.
function Arrival.start()
	local function watchRoom(room: Instance)
		room.ChildAdded:Connect(function(c)
			if c.Name == "RoomModel" then
				task.defer(Arrival.play, c)
			end
		end)
		local existing = room:FindFirstChild("RoomModel")
		if existing then
			task.defer(Arrival.play, existing)
		end
	end
	workspace.ChildAdded:Connect(function(c)
		if c.Name == "Room" then
			watchRoom(c)
		end
	end)
	local room = workspace:FindFirstChild("Room")
	if room then
		watchRoom(room)
	end
end

return Arrival

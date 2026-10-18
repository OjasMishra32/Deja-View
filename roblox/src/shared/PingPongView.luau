-- Local visuals for the real ping pong: the other paddles and a trail on the server ball (team/seb.md Update 5, B).
local PingPongView = {}

local paddles: { [number]: { part: Model, target: CFrame, seen: number } } = {}
local STALE = 3 -- seconds without a pose before a paddle is taken away
local trail: Trail? = nil
local trailBall: BasePart? = nil

local WOOD = Color3.fromRGB(205, 160, 108)
local WOOD_DARK = Color3.fromRGB(150, 98, 58)
local RED_RUBBER = Color3.fromRGB(178, 22, 30)
local BLACK_RUBBER = Color3.fromRGB(22, 22, 24)

local function piece(model: Model, name: string, shape: Enum.PartType, size: Vector3, colour: Color3, material: Enum.Material, offset: CFrame): BasePart
	local p = Instance.new("Part")
	p.Name = name
	p.Shape = shape
	p.Size = size
	p.Color = colour
	p.Material = material
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch, p.CastShadow = true, false, false, false, false
	p.TopSurface, p.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
	p:SetAttribute("Offset", offset)
	p.Parent = model
	return p
end

-- A real table tennis bat at real size (blade about 15 cm, handle about 10 cm at 3.57 studs per metre): a wooden
-- blade with red rubber on the forehand (+Y) and black on the backhand (-Y), and a two-tone handle running back
-- toward the hand (+Z) with a flared end. The blade's centre is the model's pivot, as the old flat blade's was.
local function blade(_userId: number): Model
	local m = Instance.new("Model")
	m.Name = "PPPaddle"
	local disc = CFrame.Angles(0, 0, math.rad(90)) -- a Cylinder runs along X; turn it so the disc faces Y
	local core = piece(m, "Blade", Enum.PartType.Cylinder, Vector3.new(0.05, 0.56, 0.58), WOOD, Enum.Material.Wood, disc)
	piece(m, "Forehand", Enum.PartType.Cylinder, Vector3.new(0.014, 0.545, 0.565), RED_RUBBER, Enum.Material.SmoothPlastic, CFrame.new(0, 0.032, 0) * disc)
	piece(m, "Backhand", Enum.PartType.Cylinder, Vector3.new(0.014, 0.545, 0.565), BLACK_RUBBER, Enum.Material.SmoothPlastic, CFrame.new(0, -0.032, 0) * disc)
	piece(m, "Throat", Enum.PartType.Block, Vector3.new(0.16, 0.05, 0.1), WOOD, Enum.Material.Wood, CFrame.new(0, 0, 0.29))
	piece(m, "Handle", Enum.PartType.Block, Vector3.new(0.12, 0.1, 0.34), WOOD_DARK, Enum.Material.Wood, CFrame.new(0, 0, 0.5))
	piece(m, "HandleFace", Enum.PartType.Block, Vector3.new(0.125, 0.105, 0.2), WOOD, Enum.Material.Wood, CFrame.new(0, 0, 0.45))
	piece(m, "Flare", Enum.PartType.Block, Vector3.new(0.15, 0.115, 0.07), WOOD_DARK, Enum.Material.Wood, CFrame.new(0, 0, 0.67))
	m.PrimaryPart = core
	m.Parent = workspace
	return m
end

local function place(m: Model, cf: CFrame)
	for _, p in m:GetChildren() do
		if p:IsA("BasePart") then
			p.CFrame = cf * (p:GetAttribute("Offset") :: CFrame)
		end
	end
	m:SetAttribute("At", cf)
end

function PingPongView.paddle(userId: number, cf: CFrame)
	local entry = paddles[userId]
	if not entry then
		entry = { part = blade(userId), target = cf, seen = os.clock() }
		paddles[userId] = entry
		place(entry.part, cf)
		return
	end
	entry.target = cf
	entry.seen = os.clock()
end

-- A player left: their paddle goes with them.
function PingPongView.remove(userId: number)
	local entry = paddles[userId]
	if entry then
		entry.part:Destroy()
		paddles[userId] = nil
	end
end

-- The trail and its two attachments go together, so a reused ball does not collect attachments.
local function dropTrail()
	if trail then
		if trail.Attachment0 then
			trail.Attachment0:Destroy()
		end
		if trail.Attachment1 then
			trail.Attachment1:Destroy()
		end
		trail:Destroy()
	end
	trail, trailBall = nil, nil
end

function PingPongView.update(dt: number, shownBall: BasePart?)
	local t = os.clock()
	for id, entry in paddles do
		if t - entry.seen > STALE then
			entry.part:Destroy()
			paddles[id] = nil
		elseif entry.part.Parent then
			local at = (entry.part:GetAttribute("At") :: CFrame?) or entry.target
			place(entry.part, at:Lerp(entry.target, math.clamp(dt * 12, 0, 1)))
		end
	end
	-- search the workspace only when the ball we know is gone, not every frame
	local ball = shownBall or (if trailBall and trailBall.Parent then trailBall else workspace:FindFirstChild("PPBall", true))
	if ball and ball:IsA("BasePart") then
		if trailBall ~= ball then
			dropTrail()
			-- a Trail is as wide as the gap between its two attachments, so they sit above and below the centre
			local a0 = Instance.new("Attachment")
			a0.Position = Vector3.new(0, 0.12, 0)
			a0.Parent = ball
			local a1 = Instance.new("Attachment")
			a1.Position = Vector3.new(0, -0.12, 0)
			a1.Parent = ball
			local t = Instance.new("Trail")
			t.Name = "PPTrail"
			t.Attachment0 = a0
			t.Attachment1 = a1
			t.Lifetime = 0.18
			t.MinLength = 0
			t.Color = ColorSequence.new(Color3.fromRGB(255, 200, 120))
			t.Transparency = NumberSequence.new(0.2, 1)
			t.Parent = ball
			trail, trailBall = t, ball
		end
	elseif trail then
		dropTrail()
	end
end

function PingPongView.clear()
	for id, entry in paddles do
		entry.part:Destroy()
		paddles[id] = nil
	end
	dropTrail()
end

return PingPongView

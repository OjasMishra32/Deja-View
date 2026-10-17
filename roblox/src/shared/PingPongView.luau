-- Local visuals for the real ping pong: the other paddles and a trail on the server ball (team/seb.md Update 5, B).
local PingPongView = {}

local paddles: { [number]: { part: Part, target: CFrame } } = {}
local trail: Trail? = nil
local trailBall: BasePart? = nil

local function blade(userId: number): Part
	local p = Instance.new("Part")
	p.Name = "PPPaddle"
	p.Size = Vector3.new(0.55, 0.08, 0.57)
	p.Color = if userId % 2 == 0 then Color3.fromRGB(90, 170, 255) else Color3.fromRGB(255, 120, 90)
	p.Material = Enum.Material.SmoothPlastic
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch = true, false, false, false
	p.Parent = workspace
	return p
end

function PingPongView.paddle(userId: number, cf: CFrame)
	local entry = paddles[userId]
	if not entry then
		entry = { part = blade(userId), target = cf }
		paddles[userId] = entry
		entry.part.CFrame = cf
		return
	end
	entry.target = cf
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

function PingPongView.update(dt: number)
	for _, entry in paddles do
		if entry.part.Parent then
			entry.part.CFrame = entry.part.CFrame:Lerp(entry.target, math.clamp(dt * 12, 0, 1))
		end
	end
	-- search the workspace only when the ball we know is gone, not every frame
	local ball = if trailBall and trailBall.Parent then trailBall else workspace:FindFirstChild("PPBall", true)
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

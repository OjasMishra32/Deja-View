-- Local visuals for the real ping pong: the other paddles and a trail on the server ball (team/seb.md Update 5, B).
local Players = game:GetService("Players")
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

function PingPongView.update(dt: number)
	for _, entry in paddles do
		if entry.part.Parent then
			entry.part.CFrame = entry.part.CFrame:Lerp(entry.target, math.clamp(dt * 12, 0, 1))
		end
	end
	local ball = workspace:FindFirstChild("PPBall", true)
	if ball and ball:IsA("BasePart") then
		if trailBall ~= ball then
			if trail then
				trail:Destroy()
			end
			local t = Instance.new("Trail")
			t.Name = "PPTrail"
			t.Attachment0 = Instance.new("Attachment", ball)
			t.Attachment1 = Instance.new("Attachment", ball)
			t.Lifetime = 0.18
			t.MinLength = 0
			t.Color = ColorSequence.new(Color3.fromRGB(255, 200, 120))
			t.Transparency = NumberSequence.new(0.2, 1)
			t.Parent = ball
			trail, trailBall = t, ball
		end
	elseif trail then
		trail:Destroy()
		trail, trailBall = nil, nil
	end
end

function PingPongView.clear()
	for id, entry in paddles do
		entry.part:Destroy()
		paddles[id] = nil
	end
	if trail then
		trail:Destroy()
		trail, trailBall = nil, nil
	end
end

return PingPongView

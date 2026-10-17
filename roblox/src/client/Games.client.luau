-- Real ping pong input (team/seb.md Update 5, section B): VR paddle, the phone/PC HIT, and the other paddles.
-- Its own LocalScript, so Client.client.luau stays Shivin's.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local PingPongView = require(script.Parent.Modules.PingPongView)

local player = Players.LocalPlayer
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local PPPaddle = Remotes:WaitForChild("PPPaddle") :: UnreliableRemoteEvent
local PPHit = Remotes:WaitForChild("PPHit") :: RemoteEvent
local PPState = Remotes:WaitForChild("PPState") :: RemoteEvent
local PPSide = Remotes:WaitForChild("PPSide") :: RemoteEvent

local GRIP = CFrame.new(0, 0, -0.35) * CFrame.Angles(math.rad(-20), 0, 0)
local PADDLE_SEND = 1 / 30
local ASSIST_SEND = 1 / 5
local HIT_COOLDOWN = 0.25

local lastSend = 0
local lastAssist = 0
local lastHit = 0
local hand = Enum.UserCFrame.RightHand
local active = false
local mySide: string? = nil
local canHit = false
local bounce: string? = nil
local serving = false
local serveSide: string? = nil
local lastBlade: CFrame? = nil
local paddleVel = Vector3.zero

-- HUD: one HIT button that works with a thumb, a click or a Quest trigger.
local gui = Instance.new("ScreenGui")
gui.Name = "PPHud"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")
local hitButton = Instance.new("TextButton")
hitButton.Name = "PPHit"
hitButton.Size = UDim2.fromOffset(132, 132)
hitButton.AnchorPoint = Vector2.new(1, 1)
hitButton.Position = UDim2.new(1, -28, 1, -28)
hitButton.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
hitButton.BackgroundTransparency = 0.1
hitButton.Text = "HIT"
hitButton.TextScaled = false
hitButton.TextSize = 28
hitButton.Font = Enum.Font.GothamBold
hitButton.TextColor3 = Color3.fromRGB(0, 122, 255)
hitButton.Visible = false
hitButton.Parent = gui
local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(1, 0)
corner.Parent = hitButton

local function aimFrom(x: number?): number
	if not x then
		return 0
	end
	local width = workspace.CurrentCamera and workspace.CurrentCamera.ViewportSize.X or 1280
	local f = x / math.max(1, width)
	if f < 0.33 then
		return -0.7
	elseif f > 0.67 then
		return 0.7
	end
	return 0
end

local function fireHit(aim: number)
	if not active or not canHit or os.clock() - lastHit < HIT_COOLDOWN then
		return
	end
	lastHit = os.clock()
	PPHit:FireServer({ aim = aim, flight = 0.7 })
end

local function fireVrHit(bladeCf: CFrame)
	if not active or not canHit or os.clock() - lastHit < HIT_COOLDOWN then
		return
	end
	local b = workspace:FindFirstChild("PPBall", true)
	if not b or not b:IsA("BasePart") then
		return
	end
	if (b.Position - bladeCf.Position).Magnitude > 2.2 then
		return
	end
	lastHit = os.clock()
	PPHit:FireServer({ vr = true, cf = bladeCf, vel = paddleVel, p = b.Position, t = workspace:GetServerTimeNow() })
end

hitButton.Activated:Connect(function()
	fireHit(aimFrom(hitButton.AbsolutePosition.X + hitButton.AbsoluteSize.X / 2))
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed or not active then
		return
	end
	if input.KeyCode == Enum.KeyCode.E then
		fireHit(0)
	elseif input.UserInputType == Enum.UserInputType.MouseButton1 then
		fireHit(aimFrom(input.Position.X))
	elseif input.UserInputType == Enum.UserInputType.Touch then
		fireHit(aimFrom(input.Position.X))
	end
end)

local function handCframe(): CFrame?
	local cam = workspace.CurrentCamera
	if not cam then
		return nil
	end
	local h = UserInputService:GetUserCFrame(hand)
	return cam.CFrame * CFrame.new(h.Position * cam.HeadScale) * h.Rotation
end

local function ballPart(): BasePart?
	local b = workspace:FindFirstChild("PPBall", true)
	return if b and b:IsA("BasePart") then b else nil
end

local function tryVrHit(bladeCf: CFrame)
	local b = ballPart()
	if not b then
		return
	end
	local rel = b.Position - bladeCf.Position
	if rel.Magnitude > 0.9 then
		return
	end
	-- only when the ball is in front of the blade and coming at it
	local n = bladeCf.UpVector
	if rel:Dot(n) < 0 then
		return
	end
	fireVrHit(bladeCf)
end

RunService.RenderStepped:Connect(function(dt)
	PingPongView.update(dt)
	if not active then
		return
	end
	local t = os.clock()
	if UserInputService.VREnabled then
		local cf = handCframe()
		if cf then
			local bladeCf = cf * GRIP
			if lastBlade then
				paddleVel = (bladeCf.Position - lastBlade.Position) / math.max(0.008, dt)
			end
			lastBlade = bladeCf
			if t - lastSend >= PADDLE_SEND then
				lastSend = t
				PPPaddle:FireServer(bladeCf)
			end
			tryVrHit(bladeCf)
		end
	elseif t - lastAssist >= ASSIST_SEND then
		lastAssist = t
		local char = player.Character
		local hrp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
		if hrp then
			PPPaddle:FireServer(hrp.CFrame * CFrame.new(1.4, -0.2, -1.1) * GRIP)
		end
	end
end)

PPPaddle.OnClientEvent:Connect(function(userId, cf)
	if type(userId) == "number" and typeof(cf) == "CFrame" then
		PingPongView.paddle(userId, cf)
	end
end)

PPSide.OnClientEvent:Connect(function(side)
	if side == "A" or side == "B" then
		mySide = side
	end
end)

local function refreshHitButton()
	local mine = mySide
	if not active or not mine then
		hitButton.Visible = false
		canHit = false
		return
	end
	hitButton.Visible = true
	local serveNow = serving and serveSide == mine
	local bounceNow = bounce == mine
	canHit = serveNow or bounceNow
	hitButton.Text = if canHit then (serveNow and "SERVE" or "HIT") else (serving and "WAIT" or "WAIT")
	hitButton.BackgroundTransparency = if canHit then 0.1 else 0.6
	hitButton.TextColor3 = if canHit then Color3.fromRGB(0, 122, 255) else Color3.fromRGB(150, 150, 155)
end

PPState.OnClientEvent:Connect(function(msg)
	if type(msg) ~= "table" then
		return
	end
	if msg.active ~= nil then
		active = msg.active == true
		if not active then
			mySide = nil
			PingPongView.clear()
		end
	end
	if msg.serve ~= nil then
		serveSide = msg.serve
	end
	if msg.serving ~= nil then
		serving = msg.serving == true
	end
	if msg.bounce ~= nil then
		bounce = msg.bounce
	end
	refreshHitButton()
end)

workspace:GetAttributeChangedSignal("PPActive"):Connect(function()
	local on = workspace:GetAttribute("PPActive") == true
	if on ~= active then
		active = on
		if not on then
			mySide = nil
			PingPongView.clear()
		end
		refreshHitButton()
	end
end)

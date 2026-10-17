-- Builds the ScreenGui: loading screen, HUD, host bar, JOIN, banner, toasts, scoreboard,
-- countdown, TAGGED, winner card and the Rooms panel. Client.client.luau drives it.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Theme = require(Shared.Theme)

local make, label, button = Theme.make, Theme.label, Theme.button

local Ui = {}

local TIPS = {
	"Every block is a piece of a real place.",
	"The lime ghost is the judge in the headset.",
	"Stay away from the judge's hands during tag.",
	"Press R to switch rooms.",
}

function Ui.build()
	local player = Players.LocalPlayer
	local gui = make("ScreenGui", {
		Name = "DejaViewUI", ResetOnSpawn = false, IgnoreGuiInset = true,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling, Parent = player:WaitForChild("PlayerGui"),
	})
	local ui: { [string]: any } = { gui = gui }

	-- Loading screen
	local loading = make("Frame", { Name = "Loading", Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg,
		ZIndex = 50, Parent = gui })
	ui.loading = loading
	local col = make("Frame", { BackgroundTransparency = 1, AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.fromScale(0.8, 0.6), ZIndex = 51, Parent = loading },
		{ make("UISizeConstraint", { MaxSize = Vector2.new(900, 500) }) })
	label({ Text = "DÉJÀ VIEW", TextColor3 = Theme.Accent, FontFace = Theme.Heading, Size = UDim2.fromScale(1, 0.1),
		ZIndex = 52, MaxText = 24, Parent = col })
	ui.loadTitle = label({ Text = "Moving in...", FontFace = Theme.Heading, Size = UDim2.fromScale(1, 0.3),
		Position = UDim2.fromScale(0, 0.14), ZIndex = 52, MaxText = 96, Parent = col })
	ui.loadRoom = label({ Text = "", TextColor3 = Theme.Muted, Size = UDim2.fromScale(1, 0.1),
		Position = UDim2.fromScale(0, 0.46), ZIndex = 52, MaxText = 28, Parent = col })
	local bar = make("Frame", { BackgroundColor3 = Theme.Stroke, Size = UDim2.new(1, 0, 0, 6),
		Position = UDim2.fromScale(0, 0.62), ZIndex = 52, Parent = col }, { Theme.corner(3) })
	ui.loadFill = make("Frame", { BackgroundColor3 = Theme.Accent, Size = UDim2.fromScale(0, 1), ZIndex = 53,
		Parent = bar }, { Theme.corner(3) })
	ui.loadCount = label({ Text = "", TextColor3 = Theme.Muted, Size = UDim2.fromScale(1, 0.08),
		Position = UDim2.fromScale(0, 0.67), ZIndex = 52, MaxText = 18, Parent = col })
	ui.loadTip = label({ Text = TIPS[1], TextColor3 = Theme.Muted, Size = UDim2.fromScale(1, 0.07),
		Position = UDim2.fromScale(0, 0.88), ZIndex = 52, MaxText = 16, Parent = col })
	task.spawn(function()
		local i = 1
		while gui.Parent do
			task.wait(4)
			i = i % #TIPS + 1
			ui.loadTip.Text = TIPS[i]
		end
	end)

	-- HUD (top-left, below the Roblox top bar)
	local hud = make("Frame", { Name = "Hud", BackgroundTransparency = 1, Position = UDim2.new(0, 16, 0, 64),
		Size = UDim2.new(0.42, 0, 0, 110), Parent = gui }, { make("UISizeConstraint", { MaxSize = Vector2.new(520, 110) }) })
	ui.roomName = label({ Text = "LOBBY", FontFace = Theme.Heading, Size = UDim2.new(1, 0, 0, 30), MaxText = 30,
		TextStrokeTransparency = 0.6, Parent = hud })
	ui.status = label({ Text = "", TextColor3 = Theme.Accent, Size = UDim2.new(1, 0, 0, 20), Position = UDim2.new(0, 0, 0, 32),
		MaxText = 18, TextStrokeTransparency = 0.6, Parent = hud })
	local row = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 44), Position = UDim2.new(0, 0, 0, 58),
		Parent = hud }, { make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 8),
		SortOrder = Enum.SortOrder.LayoutOrder }) })
	ui.roomsBtn = button({ Text = "ROOMS (R)", Size = UDim2.new(0, 120, 1, 0), LayoutOrder = 1, Parent = row })
	ui.hopBtn = button({ Text = "LOBBY", Size = UDim2.new(0, 100, 1, 0), LayoutOrder = 2, Parent = row })
	ui.realityBtn = button({ Text = "REALITY CHECK", Size = UDim2.new(0, 150, 1, 0), LayoutOrder = 3, Visible = false,
		Parent = row })

	-- Host bar (left middle)
	local host = make("Frame", { Name = "HostBar", BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.05,
		Position = UDim2.new(0, 16, 0, 184), Size = UDim2.new(0, 170, 0, 300), Visible = false, Parent = gui },
		{ Theme.corner(14), Theme.stroke(), make("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10),
			PaddingTop = UDim.new(0, 10), PaddingBottom = UDim.new(0, 10) }),
		  make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }) })
	ui.host = host
	label({ Text = "HOST", TextColor3 = Theme.Muted, FontFace = Theme.Heading, Size = UDim2.new(1, 0, 0, 16), MaxText = 14,
		LayoutOrder = 0, Parent = host })
	local function hostBtn(key, text, order)
		ui[key] = button({ Text = text, Size = UDim2.new(1, 0, 0, 34), LayoutOrder = order, MaxText = 14, Parent = host })
	end
	hostBtn("autoBtn", "AUTO-JOIN: ON", 1)
	hostBtn("followBtn", "FOLLOW: ON", 2)
	hostBtn("startBtn", "START ROUND", 3)
	hostBtn("endBtn", "END ROUND", 4)
	hostBtn("mockBtn", "MOCK JUDGE: OFF", 5)
	hostBtn("lobbyAllBtn", "ALL TO LOBBY", 6)

	-- Big JOIN (bottom centre, clear of the thumbstick and jump corners)
	ui.joinBtn = button({ Text = "JOIN", AnchorPoint = Vector2.new(0.5, 1), Position = UDim2.new(0.5, 0, 1, -28),
		Size = UDim2.new(0.3, 0, 0, 64), BackgroundColor3 = Theme.Accent, TextColor3 = Theme.Bg, MaxText = 34,
		Visible = false, Parent = gui })
	make("UISizeConstraint", { MinSize = Vector2.new(160, 56), MaxSize = Vector2.new(360, 72), Parent = ui.joinBtn })

	-- Banner
	ui.banner = label({ Text = "", AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 64),
		Size = UDim2.new(0.4, 0, 0, 40), BackgroundTransparency = 0, BackgroundColor3 = Theme.Danger,
		TextXAlignment = Enum.TextXAlignment.Center, FontFace = Theme.Heading, Visible = false, ZIndex = 40, Parent = gui })
	Theme.corner(12).Parent = ui.banner

	-- Toasts (right, middle)
	ui.toasts = make("Frame", { BackgroundTransparency = 1, AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -16, 0.55, 0), Size = UDim2.new(0.3, 0, 0.3, 0), Parent = gui },
		{ make("UIListLayout", { Padding = UDim.new(0, 6), VerticalAlignment = Enum.VerticalAlignment.Bottom,
			HorizontalAlignment = Enum.HorizontalAlignment.Right, SortOrder = Enum.SortOrder.LayoutOrder }) })

	-- Scoreboard (top-right)
	local score = make("Frame", { Name = "Scoreboard", BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.05,
		AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -16, 0, 64), Size = UDim2.new(0.24, 0, 0, 220),
		Visible = false, Parent = gui }, { Theme.corner(14), Theme.stroke(),
		make("UISizeConstraint", { MinSize = Vector2.new(200, 0), MaxSize = Vector2.new(320, 400) }),
		make("UIPadding", { PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 12), PaddingTop = UDim.new(0, 10),
			PaddingBottom = UDim.new(0, 10) }),
		make("UIListLayout", { Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder }) })
	ui.score = score
	ui.timer = label({ Text = "0:00", FontFace = Theme.Heading, Size = UDim2.new(1, 0, 0, 44), MaxText = 44,
		LayoutOrder = 0, Parent = score })
	ui.scoreRows = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 150), LayoutOrder = 1,
		AutomaticSize = Enum.AutomaticSize.Y, Parent = score },
		{ make("UIListLayout", { Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder }) })

	-- Countdown / big centre text
	ui.big = label({ Text = "", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.4),
		Size = UDim2.fromScale(0.8, 0.22), FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		TextStrokeTransparency = 0.3, MaxText = 120, Visible = false, ZIndex = 30, Parent = gui })
	ui.bigSub = label({ Text = "", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.55),
		Size = UDim2.fromScale(0.8, 0.06), TextColor3 = Theme.Accent, FontFace = Theme.Heading,
		TextXAlignment = Enum.TextXAlignment.Center, TextStrokeTransparency = 0.4, MaxText = 32, Visible = false,
		ZIndex = 30, Parent = gui })

	-- Winner card
	local winner = make("Frame", { Name = "Winner", Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg,
		BackgroundTransparency = 0.05, Visible = false, ZIndex = 45, Parent = gui })
	ui.winner = winner
	ui.winTitle = label({ Text = "", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.42),
		Size = UDim2.fromScale(0.85, 0.2), FontFace = Theme.Heading, TextXAlignment = Enum.TextXAlignment.Center,
		MaxText = 110, ZIndex = 46, Parent = winner })
	make("Frame", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.fromScale(0.5, 0.53), Size = UDim2.new(0.3, 0, 0, 6),
		BackgroundColor3 = Theme.Accent, ZIndex = 46, Parent = winner }, { Theme.corner(3) })
	ui.winSub = label({ Text = "", AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.fromScale(0.5, 0.58),
		Size = UDim2.fromScale(0.8, 0.07), TextColor3 = Theme.Muted, TextXAlignment = Enum.TextXAlignment.Center,
		MaxText = 36, ZIndex = 46, Parent = winner })

	-- Rooms panel
	local panel = make("Frame", { Name = "RoomsPanel", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.52),
		Size = UDim2.fromScale(0.86, 0.74), BackgroundColor3 = Theme.Bg, BackgroundTransparency = 0.05, Visible = false,
		ZIndex = 20, Parent = gui }, { Theme.corner(18), Theme.stroke(),
		make("UISizeConstraint", { MaxSize = Vector2.new(1100, 700) }),
		make("UIPadding", { PaddingLeft = UDim.new(0, 18), PaddingRight = UDim.new(0, 18), PaddingTop = UDim.new(0, 14),
			PaddingBottom = UDim.new(0, 14) }) })
	ui.panel = panel
	label({ Text = "PICK A ROOM", FontFace = Theme.Heading, Size = UDim2.new(1, -60, 0, 36), MaxText = 34, Parent = panel })
	ui.closeBtn = button({ Text = "X", AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, 0, 0, 0),
		Size = UDim2.fromOffset(44, 44), Parent = panel })
	ui.panelList = make("ScrollingFrame", { BackgroundTransparency = 1, Position = UDim2.new(0, 0, 0, 52),
		Size = UDim2.new(1, 0, 1, -52), CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollBarThickness = 4, ScrollBarImageColor3 = Theme.Accent, BorderSizePixel = 0, Parent = panel },
		{ make("UIGridLayout", { CellSize = UDim2.new(0.31, 0, 0, 150), CellPadding = UDim2.new(0.02, 0, 0, 12),
			SortOrder = Enum.SortOrder.LayoutOrder }) })

	return ui
end

function Ui.fadeOut(frame: Frame, seconds: number)
	local saved: { [Instance]: number } = { [frame] = frame.BackgroundTransparency }
	local info = TweenInfo.new(seconds)
	TweenService:Create(frame, info, { BackgroundTransparency = 1 }):Play()
	for _, d in frame:GetDescendants() do
		if d:IsA("TextLabel") then
			saved[d] = d.TextTransparency
			TweenService:Create(d, info, { TextTransparency = 1 }):Play()
		elseif d:IsA("Frame") and d.BackgroundTransparency < 1 then
			saved[d] = d.BackgroundTransparency
			TweenService:Create(d, info, { BackgroundTransparency = 1 }):Play()
		end
	end
	task.delay(seconds, function()
		frame.Visible = false
		-- restore for the next time it is shown
		for inst, v in saved do
			if inst:IsA("TextLabel") then
				inst.TextTransparency = v
			else
				(inst :: Frame).BackgroundTransparency = v
			end
		end
	end)
end

function Ui.toast(ui, text: string)
	local t = label({ Text = text, AutomaticSize = Enum.AutomaticSize.X, Size = UDim2.new(0, 0, 0, 40), TextScaled = false,
		TextSize = 18, FontFace = Theme.Heading, BackgroundTransparency = 0.05, BackgroundColor3 = Theme.Surface,
		TextXAlignment = Enum.TextXAlignment.Center, LayoutOrder = math.floor(os.clock() * 100), Parent = ui.toasts })
	make("UIPadding", { PaddingLeft = UDim.new(0, 14), PaddingRight = UDim.new(0, 14), Parent = t })
	Theme.corner(12).Parent = t
	Theme.stroke(Theme.Accent).Parent = t
	task.delay(4, function()
		TweenService:Create(t, TweenInfo.new(0.4), { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
		task.wait(0.45)
		t:Destroy()
	end)
end

function Ui.big(ui, text: string, sub: string?, color: Color3?, seconds: number?)
	ui.big.Text = text
	ui.big.TextColor3 = color or Theme.Text
	ui.big.Visible = true
	ui.bigSub.Text = sub or ""
	ui.bigSub.Visible = sub ~= nil and sub ~= ""
	local stamp = os.clock()
	ui.bigStamp = stamp
	ui.big.Size = UDim2.fromScale(0.95, 0.27)
	TweenService:Create(ui.big, TweenInfo.new(0.25, Enum.EasingStyle.Back), { Size = UDim2.fromScale(0.8, 0.22) }):Play()
	task.delay(seconds or 1.2, function()
		if ui.bigStamp == stamp then
			ui.big.Visible = false
			ui.bigSub.Visible = false
		end
	end)
end

function Ui.scoreRow(parent: Instance, name: string, right: string, color: Color3, order: number)
	local row = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 26), LayoutOrder = order, Parent = parent })
	label({ Text = name, TextColor3 = color, Size = UDim2.new(0.62, 0, 1, 0), MaxText = 20, FontFace = Theme.Heading, Parent = row })
	label({ Text = right, TextColor3 = color, Size = UDim2.new(0.38, 0, 1, 0), Position = UDim2.fromScale(0.62, 0),
		TextXAlignment = Enum.TextXAlignment.Right, MaxText = 20, FontFace = Theme.Heading, Parent = row })
end

return Ui

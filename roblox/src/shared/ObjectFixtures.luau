-- Fallback object layers for scenes whose server does not serve objects.json yet.
-- These are real pipeline results, copied from data/scenes/<id>/objects.json. The server
-- value wins when it is present; this keeps the demo place working during the rollout.
local ObjectFixtures = {}

ObjectFixtures.kitchen = {
	version = 1,
	sceneId = "kitchen",
	units = "studs",
	studsPerMeter = 3.57,
	style = "flat",
	objects = {
		{
			id = "fridge",
			label = "fridge",
			confidence = 0.8002,
			center = { -3.198, 3.01, -10.89 },
			size = { 3.23, 5.883, 3.684 },
			yaw = 0,
			shape = "box",
			color = { 104, 93, 87 },
			parts = {},
			source = { splats = 9085, views = 5, detections = 5, score = 0.8445 },
		},
	},
}

return ObjectFixtures

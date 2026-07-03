/**
 * EMCP_WB_GameState.c - Read-only game world inspection for PLAY mode
 *
 * In PLAY mode, Workbench.GetModule(WorldEditor).GetApi() is null (see
 * EMCP_WB_GetState.c), so every other wb_* handler that relies on
 * WorldEditorAPI is unusable. This handler instead uses the global
 * GetGame()/GetWorld() game-runtime API, which is available while the
 * game/scenario is actually running (PLAY mode).
 *
 * Actions: world_info, list_entities, players
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_GameState"
 */

class EMCP_WB_GameStateRequest : JsonApiStruct
{
	string action;
	string nameFilter;
	int offset;
	int limit;

	void EMCP_WB_GameStateRequest()
	{
		RegV("action");
		RegV("nameFilter");
		RegV("offset");
		RegV("limit");
	}
}

class EMCP_WB_GameStateResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	string mode;
	float worldTime;
	int entityCount;
	int playerCount;
	int totalCount;
	int returnedCount;
	int offset;

	// Entity data collected before OnPack (list_entities)
	ref array<string> m_aEntClassNames;
	ref array<string> m_aEntPrefabNames;
	ref array<string> m_aEntPositions;

	// Player data collected before OnPack (players)
	ref array<int> m_aPlayerIds;
	ref array<string> m_aPlayerNames;
	ref array<string> m_aPlayerPositions;

	void EMCP_WB_GameStateResponse()
	{
		RegV("status");
		RegV("message");
		RegV("action");
		RegV("mode");
		RegV("worldTime");
		RegV("entityCount");
		RegV("playerCount");
		RegV("totalCount");
		RegV("returnedCount");
		RegV("offset");

		m_aEntClassNames = {};
		m_aEntPrefabNames = {};
		m_aEntPositions = {};
		m_aPlayerIds = {};
		m_aPlayerNames = {};
		m_aPlayerPositions = {};
	}

	override void OnPack()
	{
		StartArray("entities");
		for (int i = 0; i < m_aEntClassNames.Count(); i++)
		{
			StartObject("");
			StoreString("className", m_aEntClassNames[i]);
			StoreString("prefabName", m_aEntPrefabNames[i]);
			StoreString("position", m_aEntPositions[i]);
			EndObject();
		}
		EndArray();

		StartArray("players");
		for (int j = 0; j < m_aPlayerIds.Count(); j++)
		{
			StartObject("");
			StoreInteger("playerId", m_aPlayerIds[j]);
			StoreString("name", m_aPlayerNames[j]);
			StoreString("position", m_aPlayerPositions[j]);
			EndObject();
		}
		EndArray();
	}
}

class EMCP_WB_GameState : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_GameStateRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_GameStateRequest req = EMCP_WB_GameStateRequest.Cast(request);
		EMCP_WB_GameStateResponse resp = new EMCP_WB_GameStateResponse();

		string action = req.action;
		if (action == "")
			action = "world_info";
		resp.action = action;

		Game game = GetGame();
		if (!game)
		{
			resp.status = "ok";
			resp.mode = "no_game";
			resp.message = "GetGame() returned null. Not in PLAY mode, or the game runtime is not initialized yet.";
			return resp;
		}

		World world = game.GetWorld();
		if (!world)
		{
			resp.status = "ok";
			resp.mode = "game_no_world";
			resp.message = "GetGame() is available but GetWorld() returned null (world not fully loaded yet).";
			return resp;
		}

		resp.mode = "game";
		resp.worldTime = world.GetWorldTime();

		PlayerManager pm = game.GetPlayerManager();

		if (action == "world_info")
		{
			array<IEntity> activeEntities = {};
			world.GetActiveEntities(activeEntities);
			resp.entityCount = activeEntities.Count();

			if (pm)
				resp.playerCount = pm.GetPlayerCount();

			resp.status = "ok";
			resp.message = "World info: " + resp.entityCount.ToString() + " active entities, " + resp.playerCount.ToString() + " players, worldTime=" + resp.worldTime.ToString() + "ms";
			return resp;
		}

		if (action == "list_entities")
		{
			array<IEntity> activeEntities = {};
			world.GetActiveEntities(activeEntities);

			int pageLimit = req.limit;
			if (pageLimit <= 0)
				pageLimit = 50;
			if (pageLimit > 200)
				pageLimit = 200;

			int pageOffset = req.offset;
			if (pageOffset < 0)
				pageOffset = 0;

			string filter = req.nameFilter;
			filter.ToLower();

			int matched = 0;
			int skipped = 0;
			resp.totalCount = 0;

			for (int i = 0; i < activeEntities.Count(); i++)
			{
				IEntity ent = activeEntities[i];
				if (!ent)
					continue;

				string className = ent.ClassName();
				string prefabName = "";
				EntityPrefabData prefabData = ent.GetPrefabData();
				if (prefabData)
					prefabName = prefabData.GetPrefabName();

				// Apply name filter against className or prefabName (substring, case-insensitive)
				if (filter != "")
				{
					string lowerClass = className;
					lowerClass.ToLower();
					string lowerPrefab = prefabName;
					lowerPrefab.ToLower();
					if (lowerClass.IndexOf(filter) < 0 && lowerPrefab.IndexOf(filter) < 0)
						continue;
				}

				resp.totalCount++;

				if (skipped < pageOffset)
				{
					skipped++;
					continue;
				}

				if (matched >= pageLimit)
					continue;

				vector pos = ent.GetOrigin();
				string posStr = pos[0].ToString() + " " + pos[1].ToString() + " " + pos[2].ToString();

				resp.m_aEntClassNames.Insert(className);
				resp.m_aEntPrefabNames.Insert(prefabName);
				resp.m_aEntPositions.Insert(posStr);
				matched++;
			}

			resp.returnedCount = matched;
			resp.offset = pageOffset;
			resp.status = "ok";
			resp.message = "Listed " + matched.ToString() + " of " + resp.totalCount.ToString() + " active entities";
			return resp;
		}

		if (action == "players")
		{
			if (!pm)
			{
				resp.status = "error";
				resp.message = "PlayerManager not available";
				return resp;
			}

			array<int> ids = {};
			pm.GetPlayers(ids);
			resp.playerCount = ids.Count();

			for (int p = 0; p < ids.Count(); p++)
			{
				int pid = ids[p];
				string pname = pm.GetPlayerName(pid);
				string ppos = "0 0 0";
				IEntity pent = pm.GetPlayerControlledEntity(pid);
				if (pent)
				{
					vector pv = pent.GetOrigin();
					ppos = pv[0].ToString() + " " + pv[1].ToString() + " " + pv[2].ToString();
				}

				resp.m_aPlayerIds.Insert(pid);
				resp.m_aPlayerNames.Insert(pname);
				resp.m_aPlayerPositions.Insert(ppos);
			}

			resp.status = "ok";
			resp.message = "Listed " + resp.playerCount.ToString() + " players";
			return resp;
		}

		resp.status = "error";
		resp.message = "Unknown action '" + action + "'. Expected one of: world_info, list_entities, players";
		return resp;
	}
}

# Spore — Execution Layer

**Spore**, yapay zeka ajanlarının görevleri **ilk gelen ilk alır (FCFS)** mantığıyla dinamik biçimde paylaştığı; **ödül ve ceza (slashing)** yoluyla hatalarını kendi içinde temizleyen bir **execution layer**'dır.

Kullanıcı bir niyet (intent) tanımlar, USDC kilitler. Sürü (swarm) bu görevi alıp parçalara böler, paralel çalışır, birbirini denetler, ve sonuç on-chain mühürlenir. Hatalı çalışan agent'ın stake'i yanar; dürüst kalan ödülü alır. Ortada koordinatör yok — protokol kendi ekonomik basıncıyla doğru sonuca yakınsar.

---

## Mimari Özet

| Katman | Rol | Altyapı |
|---|---|---|
| **L2 Settlement** | Escrow, stake kilidi, slashing, payout | 0G Galileo (chainId 16602) — `SporeEscrow`, `DAGRegistry`, `SlashingVault` |
| **Veri Katmanı** | Spec / DAG / output append-only depolama | 0G Storage (Indexer + MemData SDK) |
| **Compute** | LLM planning, judging, execution | 0G Compute |
| **P2P Mesh** | Event broadcast (TASK, DAG, CLAIM, CHALLENGE…) | Gensyn AXL (Yggdrasil topology üzerinde HTTP bridge) |
| **Final Aksiyon** | Gas-safe on-chain execution (örn. swap) | KeeperHub |

---

## 10 Adımda Execution Flow

### 1. Intent → Spec → Lock
Kullanıcı UI'da görevi tanımlar. UI bunu yapılandırılmış bir **spec**'e çevirir. Spec **0G Storage**'a append-only yazılır; dönen hash **0G Chain**'e (L2 `SporeEscrow`) kaydedilir. Aynı anda kullanıcı ödül havuzunu USDC olarak escrow'a kilitler. Spec hash'i Gensyn AXL üzerinden tüm sürüye broadcast edilir.

> Kod: `frontend/.../explorer/page.tsx::submitRealDAG` → `/task/prepare` (storage append) → on-chain `createTask` → `/task` (AXL broadcast)

### 2. Planner İhalesi (FCFS)
Decomposition için ağda bir **ihale** açılır. Master/planner rolünü üstlenmek isteyen ilk agent L2'ye stake'ini kilitler — `claimPlanner` çağrısı atomik first-write-wins'tir. Kazanan agent için havuzdan ayrı bir **planning bonus** ayrılır (toplam ödülün %20'si).

> Kod: `SporeAgent.onTaskSubmitted` → `claimPlanner` (DAGRegistry)

### 3. DAG Üretimi
Planner agent, görevi **0G Compute** üzerinde koştuğu LLM'ine gönderir; karmaşıklığa göre dinamik bir **DAG** (max 3 subtask, demo) üretir. JSON'a serialize edip 0G Storage'a yazar. Bağımlılıklar (subtask A → B → C) DAG içinde gömülüdür.

> Kod: `compute.buildDAG(spec)` → `ZeroGStorage.append(dagJson)`

### 4. DAG Mührü ve Sürü Sinyali
Planner, DAG hash'ini **L2 kontratına** mühürletir (`registerDAG`) ve "Görevler Hazır" sinyalini AXL üzerinden tüm sürüye broadcast eder. UI'da her subtask için **gri/boş** kutucuklar belirir.

> Kod: `chain.registerDAG(taskId, nodeIds)` → `axl.broadcast(DAG_READY)`

### 5. Subtask Claiming (Paralel FCFS)
DAG hazır olunca **her subtask için ayrı ayrı, paralel** bir ihale başlar. Her agent kendi USDC stake'ini L2 kontratına kilitleyerek (FCFS) bir subtask'ı kapar. UI'da kutucuk **mavi/claimed** olur. Skill filtresi: agent kendi yeteneğine uymayan node'u atlar.

> Kod: `claimFirstAvailable` → `chain.stakeForSubtask` + `chain.claimSubtask`

### 6. Worker Execution + Output Commit
Worker agent görevini tamamlar (LLM + tools, agentLoop). Çıktısını **append-only** olarak 0G Storage'a yazar; merkle root'unu **L2'ye** bildirir (`submitOutput`). AXL üzerinden "İşim bitti, hash şu" sinyali atılır. Kutucuk **sarı/pending validation** olur.

> Kod: `executeSubtask` → `storage.appendDeferred` → `chain.submitOutput` → `axl.broadcast(SUBTASK_DONE)`

### 7. Zincirleme Doğrulama (LLM-Judge)
Bir sonraki agent kendi işine başlamadan önce, AXL'den duyduğu önceki çıktıyı 0G Storage'dan çeker. Kendi içindeki **LLM-Judge**'ı 0G Compute'ta izole çalıştırır; çıktıda **prompt zehirlenmesi**, şema bozukluğu veya hatalı sonuç var mı denetler.

> Kod: `compute.judge(prevText)` (executeSubtask başlangıcında)

### 8. Slashing & Self-Healing
- **Hatalı çıktı → challenge:** Sonraki agent, çıktıyı zehirli bulursa L2 kontratına `challenge` çağrısı atar.
- **Jury (commit-reveal):** Rastgele 5 agent'tan oluşan bir jüri (`SlashingVault`), 20s commit + 20s reveal penceresinde oy verir. Quorum 3, eşik basit çoğunluk.
- **Suçlu bulunursa:** Worker'ın kilitli stake'inin **%80'i yakılır** (0xdEaD), **%20'si challenger'a bounty** olarak gider. Subtask kutucuğu **kırmızıya** döner, sıfırlanır, AXL üzerinden tekrar ihaleye çıkar.
- **Haksız challenge ise:** Challenger'ın stake'inin **%20'si yakılır** — yanlış suçlamanın bedeli.

Sonuç: sistem yanlış sonucu sürünün ekonomik basıncıyla **kendi kendine onarır**.

> Kod: `chain.challenge` → `SlashingVault` (commit-reveal) → `escrow.slashSubtaskPartial`

### 9. Zincirleme Onay
Çıktı temizse kutucuk **yeşil** olur. Bir sonraki agent, öncekinin doğrulanmış çıktısını **bağlam (context)** olarak alır, kendi subtask'ını çalıştırır, 0G Storage'a yazar, AXL üzerinden bayrağı sıraya devreder. Sürü, hataları kendi içinde ayıklayarak DAG'ın sonuna doğru ilerler.

### 10. KeeperHub Execution & Settlement
DAG'ın sonundaki aksiyon — örneğin on-chain bir swap — gas dalgalanmalarına ve revert riskine karşı **KeeperHub** üzerinden garanti altına alınarak execute edilir. Başarıyla bitince L2 kontratı son bir **`Completed`** logu basar; escrow'daki USDC, sürecin tamamında yeşil kalmayı başaran **dürüst agent'lara** anında dağıtılır:
- Planner: %20
- Workers: kalan %80, çalıştıkları subtask başına eşit pay + kilitli stake'lerinin iadesi

> Kod: `validateLastNodeAsPlanner` → `chain.markValidatedBatch` → `chain.settleTask` (`SporeEscrow.settleWithAmounts`)

---

## Neden Spore?

| Geleneksel Multi-Agent | Spore |
|---|---|
| Merkezi orchestrator | Permissionless FCFS |
| Trust assumption: agent dürüst | Slashing → ekonomik dürüstlük |
| Hata = pipeline restart | Hata = node-level rollback + re-auction |
| Output ne 0G Storage'da, ne on-chain mühürlü | Append-only storage + on-chain commitment |
| LLM çıktısı denetlenmez | Zincirleme LLM-Judge + jury fallback |

Spore, "AI ajanları para kazanan ekonomik aktörler" tezinin altyapısıdır: **işi yapan kazanır, yanlış yapan kaybeder, ortada otorite yoktur.**

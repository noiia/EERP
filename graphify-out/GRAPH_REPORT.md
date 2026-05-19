# Graph Report - .  (2026-05-19)

## Corpus Check
- 81 files · ~59,966 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 760 nodes · 1070 edges · 75 communities (37 shown, 38 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 117 edges (avg confidence: 0.82)
- Token cost: 15,350 input · 4,540 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Query Builder Tests|Query Builder Tests]]
- [[_COMMUNITY_Struct Metadata Cache|Struct Metadata Cache]]
- [[_COMMUNITY_Repository Layer Tests|Repository Layer Tests]]
- [[_COMMUNITY_Pool Configuration|Pool Configuration]]
- [[_COMMUNITY_Condition & Arg Rebasing|Condition & Arg Rebasing]]
- [[_COMMUNITY_App Bootstrap & Module Loader|App Bootstrap & Module Loader]]
- [[_COMMUNITY_ORM Public API|ORM Public API]]
- [[_COMMUNITY_DB Pool & Transactions|DB Pool & Transactions]]
- [[_COMMUNITY_Row Scanner|Row Scanner]]
- [[_COMMUNITY_Logger & DB Unit Tests|Logger & DB Unit Tests]]
- [[_COMMUNITY_Cache Unit Tests|Cache Unit Tests]]
- [[_COMMUNITY_Project Docs & Guidelines|Project Docs & Guidelines]]
- [[_COMMUNITY_Frontend Dependencies|Frontend Dependencies]]
- [[_COMMUNITY_Query Builder Semantics|Query Builder Semantics]]
- [[_COMMUNITY_Repository Implementation|Repository Implementation]]
- [[_COMMUNITY_DB Mock Executor|DB Mock Executor]]
- [[_COMMUNITY_Common Utilities|Common Utilities]]
- [[_COMMUNITY_App Configuration|App Configuration]]
- [[_COMMUNITY_Module Snapshot Files|Module Snapshot Files]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Sales Individual Module|Sales Individual Module]]
- [[_COMMUNITY_Core Interfaces|Core Interfaces]]
- [[_COMMUNITY_Sales Module|Sales Module]]
- [[_COMMUNITY_Empty Rows Sentinel|Empty Rows Sentinel]]
- [[_COMMUNITY_Upsert Builder|Upsert Builder]]
- [[_COMMUNITY_Repo Empty Rows|Repo Empty Rows]]
- [[_COMMUNITY_Module Types|Module Types]]
- [[_COMMUNITY_File Dependency Resolver|File Dependency Resolver]]
- [[_COMMUNITY_DB Schema & Migrations|DB Schema & Migrations]]
- [[_COMMUNITY_BaseModel Tests|BaseModel Tests]]
- [[_COMMUNITY_WASM Module Libs|WASM Module Libs]]
- [[_COMMUNITY_Update Builder|Update Builder]]
- [[_COMMUNITY_Upsert Builder Core|Upsert Builder Core]]
- [[_COMMUNITY_Frontend Visual Assets|Frontend Visual Assets]]
- [[_COMMUNITY_File Type Definitions|File Type Definitions]]
- [[_COMMUNITY_Executor Interface|Executor Interface]]
- [[_COMMUNITY_Insert Builder|Insert Builder]]
- [[_COMMUNITY_Select Builder|Select Builder]]
- [[_COMMUNITY_Frontend Brand Assets|Frontend Brand Assets]]
- [[_COMMUNITY_CI Test Coverage|CI Test Coverage]]
- [[_COMMUNITY_Delete Builder|Delete Builder]]
- [[_COMMUNITY_Create Operations|Create Operations]]
- [[_COMMUNITY_SPA Layout & Routing|SPA Layout & Routing]]
- [[_COMMUNITY_VS Code Debug Config|VS Code Debug Config]]
- [[_COMMUNITY_SvelteKit Layout|SvelteKit Layout]]
- [[_COMMUNITY_Svelte Config|Svelte Config]]
- [[_COMMUNITY_Logged DB Row|Logged DB Row]]
- [[_COMMUNITY_Base Model|Base Model]]
- [[_COMMUNITY_Entity Constraint|Entity Constraint]]
- [[_COMMUNITY_Code Style Config|Code Style Config]]
- [[_COMMUNITY_Select Query Alias|Select Query Alias]]
- [[_COMMUNITY_Config Types|Config Types]]
- [[_COMMUNITY_API Endpoint Skill|API Endpoint Skill]]
- [[_COMMUNITY_Docker Optimization Skill|Docker Optimization Skill]]
- [[_COMMUNITY_Concurrency Debug Skill|Concurrency Debug Skill]]
- [[_COMMUNITY_Benchmark Analysis Skill|Benchmark Analysis Skill]]
- [[_COMMUNITY_Repo Context Compression|Repo Context Compression]]
- [[_COMMUNITY_Commit Convention|Commit Convention]]
- [[_COMMUNITY_Bug Report Template|Bug Report Template]]
- [[_COMMUNITY_Improvement Template|Improvement Template]]
- [[_COMMUNITY_Feature Template|Feature Template]]
- [[_COMMUNITY_App Namespace|App Namespace]]
- [[_COMMUNITY_Root HTML Template|Root HTML Template]]
- [[_COMMUNITY_Home Page Route|Home Page Route]]
- [[_COMMUNITY_Path Edit Helpers|Path Edit Helpers]]
- [[_COMMUNITY_Module Cache Type|Module Cache Type]]
- [[_COMMUNITY_Upsert Function|Upsert Function]]
- [[_COMMUNITY_Repository Mock Executor|Repository Mock Executor]]
- [[_COMMUNITY_Query Mock Executor|Query Mock Executor]]

## God Nodes (most connected - your core abstractions)
1. `NewCondition()` - 41 edges
2. `assertContains()` - 38 edges
3. `openIntegrationDB()` - 24 edges
4. `setupProductTable()` - 21 edges
5. `productRepo()` - 21 edges
6. `newRepo()` - 20 edges
7. `assertSQL()` - 15 edges
8. `Repository[T]` - 14 edges
9. `Cond()` - 13 edges
10. `newMockRows()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Skill: migration_generation` --conceptually_related_to--> `Core Database Schema (schema.sql)`  [INFERRED]
  SKILLS.md → core/schema.sql
- `GitHub Actions: Go Test Coverage Check` --semantically_similar_to--> `Skill: test_generation`  [INFERRED] [semantically similar]
  .github/workflows/test-check.yml → SKILLS.md
- `module_migrations Table` --conceptually_related_to--> `TODO: Module Loading Config System`  [INFERRED]
  core/schema.sql → TODO.md
- `EERP Database Configuration` --shares_data_with--> `PostgreSQL Docker Service`  [EXTRACTED]
  eerp-config.json → compose.yml
- `CLAUDE.md Project Guide` --references--> `EERP Database Configuration`  [EXTRACTED]
  CLAUDE.md → eerp-config.json

## Hyperedges (group relationships)
- **CI Quality Gate: Test Coverage + CLA Check on PRs** — github_workflow_test_check, github_workflow_cla_check, github_pr_template, github_testcoverage_config [EXTRACTED 1.00]
- **Custom ORM Layer Architecture: pool, query, repo, scan, cache** — claude_orm_layer_map, skills_go_orm_generation, concept_immutable_query_builders, claude_db_struct_tags [EXTRACTED 1.00]
- **Full Project Stack: Go backend + PostgreSQL + SvelteKit frontend** — claude_project_guide, compose_postgres_service, corefront_package, eerp_config_database_config [EXTRACTED 1.00]
- **WASM Module Loading Pipeline: Detect, Load, Migrate** — module_detector_detector, module_load_loadmodule, module_migration_applymigration [EXTRACTED 0.95]
- **Module Snapshot Lifecycle: Scan, Diff, Save, Load** — module_detector_scanfiles, module_snapshot_diffsnapshots, module_snapshot_savesnapshot, module_snapshot_loadsnapshot [EXTRACTED 0.95]
- **Module Dependency Resolution and Priority Assignment** — common_filemeta_filemetamap, types_files_filemeta, concept_module_priority_loading [INFERRED 0.85]
- **StructMeta Data Flow: Cache → Scanner → Query Builders** — cache_meta_structmeta, scan_scan_rows, query_delete_deletebuilder [EXTRACTED 0.95]
- **Executor Interface Implemented by Both DB and Tx** — executor_executor_executor, db_db_db, tx_tx_tx [EXTRACTED 1.00]
- **orm.go Unifies Sub-packages as Single Public API Surface** — orm_orm_type_aliases, orm_orm_open, orm_orm_repo, orm_orm_transact, orm_orm_cond [EXTRACTED 1.00]
- **All Query Builders implement ToSQL + Execute pattern** — query_select_selectbuilder, query_insert_insertbuilder, query_update_updatebuilder, query_upsert_upsertbuilder [EXTRACTED 1.00]
- **Repository delegates all CRUD to query builders** — repo_repository_repository, query_select_selectbuilder, query_insert_insertbuilder, query_update_updatebuilder [EXTRACTED 1.00]
- **Rust WASM modules follow service/extension pattern with JSON migration** — modules_vente_module, modules_vente_lib, modules_vente_particulier_module, modules_vente_particulier_lib [INFERRED 0.85]

## Communities (75 total, 38 thin omitted)

### Community 0 - "Query Builder Tests"
Cohesion: 0.06
Nodes (55): NewCondition(), errRow, lineItem, mockExecutor, order, assertContains(), assertNotContains(), TestCondition_Rebase_MultiArgCondition() (+47 more)

### Community 1 - "Struct Metadata Cache"
Cohesion: 0.06
Nodes (34): MetadataCache.build (Reflection-based StructMeta Builder), Get(), cache.Global (Process-wide Singleton Cache), MetadataCache (sync.Map-based StructMeta Cache), parseField(), pluralize(), tableName(), Tabler Interface (Custom Table Name Override) (+26 more)

### Community 2 - "Repository Layer Tests"
Cohesion: 0.12
Nodes (33): call, errRow, hardEntity, mockExecutor, orderEntity, assertNotSQL(), assertSQL(), newHardRepo() (+25 more)

### Community 3 - "Pool Configuration"
Cohesion: 0.06
Nodes (16): Config, Open(), emptyRows, errRow, invoice, mockExec, NewNoopLogger(), orm.Open (Top-level Connection Entry Point) (+8 more)

### Community 4 - "Condition & Arg Rebasing"
Cohesion: 0.08
Nodes (8): Condition, $N Argument Rebasing, placeholders(), whereClause(), DeleteBuilder[T], InsertBuilder[T], SelectBuilder[T], UpdateBuilder[T]

### Community 5 - "App Bootstrap & Module Loader"
Cohesion: 0.09
Nodes (28): Backend Application Entrypoint (main.go), main(), Module Filesystem Snapshot Cache, FileNotExists(), MkDirIfNotExists(), FileMetaMap - Module Priority and Dependency Resolver, InitLogger(), Logger - Zap Logger Initializer (+20 more)

### Community 6 - "ORM Public API"
Cohesion: 0.18
Nodes (29): Cond(), Transact(), hardProduct, integrationDSN(), openIntegrationDB(), productRepo(), setupProductTable(), TestIntegration_Create_ReturnsPopulatedEntity() (+21 more)

### Community 7 - "DB Pool & Transactions"
Cohesion: 0.10
Nodes (14): DB, openTestDB(), testDSN(), TestIntegration_Exec_CreateDropTable(), TestIntegration_Open_Ping(), TestIntegration_Query_SelectOne(), TestIntegration_QueryRow(), TestIntegration_Transaction_Commit() (+6 more)

### Community 8 - "Row Scanner"
Cohesion: 0.09
Nodes (18): embBase, flat, mockRow, mockRows, orderEnt, newMockRows(), TestRows_AlwaysCloses(), TestRows_ColumnOrderIndependent() (+10 more)

### Community 9 - "Logger & DB Unit Tests"
Cohesion: 0.09
Nodes (16): observedLogger(), TestDB_Log_DebugOff_SuccessNotLogged(), TestDB_Log_Error_AlwaysLogged(), TestOpen_InvalidConfig_ReturnsError(), TestPgxSafeName_Exported(), LogEntry, Logger, NewZapLogger() (+8 more)

### Community 10 - "Cache Unit Tests"
Cohesion: 0.08
Nodes (7): embeddedBase, ignoredField, noTagModel, orderModel, simpleModel, softModel, tablerModel

### Community 11 - "Project Docs & Guidelines"
Cohesion: 0.10
Nodes (22): Contributor License Agreement, ORM Struct Tag Conventions (db tags), Claude Model Routing Strategy (Lightweight vs Powerful), ORM Layer Architecture Map, CLAUDE.md Project Guide, PostgreSQL Docker Service, Immutable Query Builder Pattern, Modular Monolith Architecture Pattern (+14 more)

### Community 12 - "Frontend Dependencies"
Cohesion: 0.09
Nodes (19): devDependencies, svelte, svelte-check, @sveltejs/adapter-auto, @sveltejs/kit, @sveltejs/vite-plugin-svelte, typescript, vite (+11 more)

### Community 13 - "Query Builder Semantics"
Cohesion: 0.10
Nodes (22): Condition, Immutable Builder Pattern, Soft-Delete Guard Pattern, InsertBuilder[T], SelectBuilder[T], Update[T] constructor, UpdateBuilder[T], ConflictAction (+14 more)

### Community 14 - "Repository Implementation"
Cohesion: 0.12
Nodes (3): Repository, New(), Repository[T]

### Community 15 - "DB Mock Executor"
Cohesion: 0.12
Nodes (4): newMockRows(), mockExecutor, mockRow, mockRows

### Community 16 - "Common Utilities"
Cohesion: 0.15
Nodes (7): Clean(), LowedNoSpaces(), TestClean(), errorComment, KillComment(), TestErrorNow(), testKillComment

### Community 17 - "App Configuration"
Cohesion: 0.12
Nodes (15): connect_timeout, container_pool, db_host, db_name, db_password, db_port, db_user, health_check_period (+7 more)

### Community 18 - "Module Snapshot Files"
Cohesion: 0.13
Nodes (14): 1131796f-6f39-5564-bb5e-236c8b5c03fb, Active, Dependences, ModTime, Path, Priority, Size, 730467b0-b578-56ad-9edb-eb49e8511cfa (+6 more)

### Community 19 - "TypeScript Config"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, checkJs, esModuleInterop, forceConsistentCasingInFileNames, moduleResolution, resolveJsonModule, skipLibCheck (+3 more)

### Community 20 - "Sales Individual Module"
Cohesion: 0.17
Nodes (11): active, author, auto_install, depends, description, display_name, inherited_service, is_service (+3 more)

### Community 21 - "Core Interfaces"
Cohesion: 0.33
Nodes (10): pool/config.Config (ORM Connection Pool Configuration), pool/db.DB (pgxpool Wrapper with Logging and Transactions), executor.Executor Interface (Query/QueryRow/Exec Contract), executor.TxBeginner Interface (Executor + Transaction Starter), log.Logger Interface (Query Observability Contract), NoopLogger (Default Zero-overhead Logger), ZapLogger (zap-backed Logger Implementation), orm Package Type Aliases (DB, Tx, Config, Logger, Executor) (+2 more)

### Community 22 - "Sales Module"
Cohesion: 0.20
Nodes (9): active, author, auto_install, description, display_name, is_service, name, static_files (+1 more)

### Community 27 - "Module Types"
Cohesion: 0.33
Nodes (5): Migration, Module, ModuleCache, Operation, Vente

### Community 29 - "DB Schema & Migrations"
Cohesion: 0.40
Nodes (5): module_migrations Table, Core Database Schema (schema.sql), vente Table, Skill: migration_generation, TODO: Module Loading Config System

### Community 31 - "WASM Module Libs"
Cohesion: 0.40
Nodes (5): Vente Rust WASM Entry, Vente Module (Sales Core), Vente Particulier Rust WASM Migrate, Vente Particulier DB Migration (add type_client), Vente Particulier Module (B2B Sales Extension)

### Community 34 - "Frontend Visual Assets"
Cohesion: 0.67
Nodes (4): SvelteKit Frontend (core-front), UI Background Image (bg.jpg), Warm-to-Cool Pastel Color Palette (Orange, Pink, Purple, Blue), Abstract Geometric Gradient Background Style

### Community 39 - "Frontend Brand Assets"
Cohesion: 1.00
Nodes (3): Core Frontend Application, SvelteKit Favicon, SvelteKit Framework

### Community 40 - "CI Test Coverage"
Cohesion: 1.00
Nodes (3): Test Coverage Thresholds Config, GitHub Actions: Go Test Coverage Check, Skill: test_generation

### Community 43 - "Create Operations"
Cohesion: 0.67
Nodes (3): Insert[T] constructor, Repository.Create, Repository.CreateBatch

### Community 44 - "SPA Layout & Routing"
Cohesion: 0.67
Nodes (3): SPA Architecture - SSR Disabled for Client-Side Rendering, SvelteKit Root Layout Component, SvelteKit Layout Config (SSR disabled)

## Knowledge Gaps
- **177 isolated node(s):** `module_root`, `master_key`, `container_pool`, `thread_pool`, `db_name` (+172 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **38 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `NewCondition()` connect `Query Builder Tests` to `Repository Layer Tests`, `Condition & Arg Rebasing`, `ORM Public API`, `Query Builder Semantics`, `Repository Implementation`?**
  _High betweenness centrality (0.218) - this node is a cross-community bridge._
- **Why does `Cond()` connect `ORM Public API` to `Query Builder Tests`, `Struct Metadata Cache`, `Pool Configuration`?**
  _High betweenness centrality (0.175) - this node is a cross-community bridge._
- **Why does `Open()` connect `Pool Configuration` to `App Bootstrap & Module Loader`, `ORM Public API`, `DB Pool & Transactions`, `Logger & DB Unit Tests`, `Core Interfaces`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Are the 38 inferred relationships involving `NewCondition()` (e.g. with `Cond()` and `TestCondition_Rebase_SingleArg()`) actually correct?**
  _`NewCondition()` has 38 INFERRED edges - model-reasoned connections that need verification._
- **What connects `module_root`, `master_key`, `container_pool` to the rest of the system?**
  _183 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Query Builder Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.06409130816505706 - nodes in this community are weakly interconnected._
- **Should `Struct Metadata Cache` be split into smaller, more focused modules?**
  _Cohesion score 0.06363636363636363 - nodes in this community are weakly interconnected._
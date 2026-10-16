import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as atlas from "azure-maps-control";
import * as topojson from "topojson-client";
import { Topology, GeometryCollection, GeometryObject } from "topojson-specification";

interface TerritoryInfo {
    id: string;
    name: string;
    color: string;
    // Los 7 indicadores solicitados para cada territorio:
    pciExpired: number;       // 1. PCI caducadas (<= 0 días)
    pciNotExpired: number;    // 2. PCI no caducadas (> 0 días o sin fecha)
    seExpired: number;        // 3. SE caducadas (<= 0 días)
    seNotExpired: number;     // 4. SE no caducadas (> 0 días o sin fecha)
    totalExpired: number;     // 5. Total caducadas
    totalNotExpired: number;  // 6. Total no caducadas
    totalWOs: number;         // 7. TOTAL OTs sin programar
    // Acumuladores geográficos
    postalCodesCount: number;
    sumLon: number;
    sumLat: number;
    sampleCount: number;
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
}

interface PreparedPolygon {
    cpCode: string;
    territoryId: string;
    assigned: boolean;
    ringsLonLat: [number, number][][];
    ringsWorld: [number, number][][];
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
}

interface TerritoryRenderBatch {
    territoryId: string;
    colorHex: string;
    fillRgba: string;
    strokeRgba: string;
    mergedPath: Path2D;     // Silueta fusionada con topojson.merge (sin bordes internos)
    detailedPath: Path2D;   // Silueta con bordes de cada CP (para cuando se activan los bordes)
    minWx: number;
    minWy: number;
    maxWx: number;
    maxWy: number;
}

interface CachedMasterData {
    timestamp: number;
    territories: { id: string; name: string; color: string }[];
    cpPairs: [string, string][];
}

interface DataverseQueryResult {
    entities: Record<string, unknown>[];
    nextLink?: string;
}

type MapStyleMode = "road" | "dark" | "satellite";
type BadgeDisplayMode = "compact" | "full" | "none";

// Valores del OptionSet pdw_seorpci en msdyn_workorder
const SE_OPTION_VALUE = 749690000;
const PCI_OPTION_VALUE = 749690001;

// Estado del sistema de la OT: 690970000 = Unscheduled (Sin programar)
const UNSCHEDULED_SYSTEM_STATUS = 690970000;

// Espacio de coordenadas de mundo fijo para Path2D (evita problemas de precisión de coma flotante en GPU)
const WORLD_SIZE = 65536;

// Configuración de caché en IndexedDB (TTL de 12 horas para la relación estática CP -> Territorio)
const IDB_NAME = "sec_territorios_cache_v1";
const IDB_STORE = "kv";
const MASTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// Paleta de 20 colores diferenciados de alto contraste para distinguir cada territorio
const TERRITORY_PALETTE: string[] = [
    "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
    "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5",
    "#0d9488", "#c026d3", "#ca8a04", "#e11d48", "#0284c7",
    "#15803d", "#9333ea", "#b45309", "#0369a1", "#be123c"
];

export class Territorios implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private static readonly CONTROL_VERSION = "v0.0.10";

    private _context: ComponentFramework.Context<IInputs>;
    private _container: HTMLDivElement;

    // Elementos de interfaz
    private _wrapperEl: HTMLDivElement;
    private _envPillEl: HTMLSpanElement;
    private _statusEl: HTMLSpanElement;
    private _envConfigBarEl: HTMLDivElement;
    private _envUrlInputEl: HTMLInputElement;
    private _envTokenInputEl: HTMLInputElement;
    private _mapStageEl: HTMLDivElement;
    private _mapContainerEl: HTMLDivElement;
    private _overlayCanvasEl: HTMLCanvasElement;
    private _floatingPopupEl: HTMLDivElement;
    private _legendListEl: HTMLDivElement;
    private _fileInputEl: HTMLInputElement;
    private _toggleBordersBtn: HTMLButtonElement;
    private _toggleBadgesBtn: HTMLButtonElement;
    private _styleButtons: Map<MapStyleMode, HTMLButtonElement> = new Map<MapStyleMode, HTMLButtonElement>();

    // Instancias de Azure Maps y Capas Raster (TileLayer)
    private _map: atlas.Map | null = null;
    private _mapReady = false;
    private _baseTileLayer: atlas.layer.TileLayer | null = null;
    private _hybridOverlayTileLayer: atlas.layer.TileLayer | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    // Control de renderizado a 60 FPS con requestAnimationFrame
    private _rafId: number | null = null;

    // Estado de configuración y datos en memoria
    private _currentKey = "";
    private _currentTopoUrl = "";
    private _targetEnvUrl = "";
    private _targetAccessToken = "";
    private _manualOverrideEnv = false;
    private _showInternalBorders = false;
    private _badgeMode: BadgeDisplayMode = "compact";
    private _currentStyleMode: MapStyleMode = "road";
    private _selectedCpPolygon: PreparedPolygon | null = null;
    private _selectedCpPath: Path2D | null = null;
    private _popupPositionLonLat: [number, number] | null = null;

    // Estructuras de cartografía y lotes Path2D pre-compilados
    private _rawTopology: Topology | null = null;
    private _topologyObjectKey = "";
    private _cpToTopoGeometries: Map<string, GeometryObject[]> = new Map<string, GeometryObject[]>();
    private _baseGeoJson: GeoJSON.FeatureCollection<GeoJSON.Geometry> | null = null;
    private _preparedPolygons: PreparedPolygon[] = [];
    private _renderBatches: TerritoryRenderBatch[] = [];
    private _unassignedBatchPath: Path2D | null = null;

    private _cpToTerritoryMap: Map<string, string> = new Map<string, string>();
    private _territoriesMap: Map<string, TerritoryInfo> = new Map<string, TerritoryInfo>();
    private _initialParallelBootDone = false;

    // Puntos de referencia en España para sincronizar proyección Web Mercator con Azure Maps
    private readonly _refPoint1: [number, number] = [-9.5, 43.8];
    private readonly _refPoint2: [number, number] = [3.5, 36.0];
    private readonly _refWorld1: [number, number];
    private readonly _refWorld2: [number, number];

    constructor() {
        this._refWorld1 = [this.lonToWorldX(this._refPoint1[0]), this.latToWorldY(this._refPoint1[1])];
        this._refWorld2 = [this.lonToWorldX(this._refPoint2[0]), this.latToWorldY(this._refPoint2[1])];
    }

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._context = context;
        this._container = container;

        this.ensureAzureMapsStylesheet();
        this.buildUI();
        this.initializeOrUpdate(context);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this._context = context;
        this.initializeOrUpdate(context);
    }

    private ensureAzureMapsStylesheet(): void {
        const cssId = "azure-maps-control-css-v3";
        if (!document.getElementById(cssId)) {
            const link = document.createElement("link");
            link.id = cssId;
            link.rel = "stylesheet";
            link.href = "https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.css";
            document.head.appendChild(link);
        }
    }

    private buildUI(): void {
        this._wrapperEl = document.createElement("div");
        this._wrapperEl.className = "sec-territorios-wrapper";

        // 1. Barra de herramientas principal
        const toolbar = document.createElement("div");
        toolbar.className = "sec-territorios-toolbar";

        const leftGroup = document.createElement("div");
        leftGroup.className = "sec-territorios-toolbar-left";

        const title = document.createElement("span");
        title.className = "sec-territorios-title";
        title.textContent = "🗺️ Territorios Field Service";

        this._envPillEl = document.createElement("span");
        this._envPillEl.className = "sec-territorios-env-pill";
        this._envPillEl.textContent = "Entorno: Local";

        this._statusEl = document.createElement("span");
        this._statusEl.className = "sec-territorios-status";
        this._statusEl.textContent = "Inicializando...";

        leftGroup.appendChild(title);
        leftGroup.appendChild(this._envPillEl);
        leftGroup.appendChild(this._statusEl);

        const rightGroup = document.createElement("div");
        rightGroup.className = "sec-territorios-toolbar-right";

        this._fileInputEl = document.createElement("input");
        this._fileInputEl.type = "file";
        this._fileInputEl.accept = ".json,.topojson,.geojson,.js";
        this._fileInputEl.style.display = "none";
        this._fileInputEl.addEventListener("change", (e) => this.handleLocalFileSelected(e));

        const loadLocalBtn = document.createElement("button");
        loadLocalBtn.type = "button";
        loadLocalBtn.className = "sec-territorios-btn";
        loadLocalBtn.textContent = "📂 Cargar TopoJSON";
        loadLocalBtn.title = "Selecciona el archivo TopoJSON exportado de Mapshaper desde tu equipo";
        loadLocalBtn.addEventListener("click", () => this._fileInputEl.click());

        const envToggleBtn = document.createElement("button");
        envToggleBtn.type = "button";
        envToggleBtn.className = "sec-territorios-btn";
        envToggleBtn.textContent = "🌐 Entorno Externo";
        envToggleBtn.title = "Configurar URL de otro entorno de Dataverse donde están los datos de prueba";
        envToggleBtn.addEventListener("click", () => {
            this._envConfigBarEl.classList.toggle("open");
        });

        this._toggleBordersBtn = document.createElement("button");
        this._toggleBordersBtn.type = "button";
        this._toggleBordersBtn.className = "sec-territorios-btn";
        this._toggleBordersBtn.textContent = "Bordes CPs: Ocultos";
        this._toggleBordersBtn.addEventListener("click", () => this.toggleInternalBorders());

        this._toggleBadgesBtn = document.createElement("button");
        this._toggleBadgesBtn.type = "button";
        this._toggleBadgesBtn.className = "sec-territorios-btn";
        this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Resumen";
        this._toggleBadgesBtn.title = "Alternar entre Resumen (Tot/Cad), Detalle 7 valores u Ocultas";
        this._toggleBadgesBtn.addEventListener("click", () => this.cycleBadgeMode());

        const demoBtn = document.createElement("button");
        demoBtn.type = "button";
        demoBtn.className = "sec-territorios-btn";
        demoBtn.textContent = "⚡ Simular (Test)";
        demoBtn.title = "Genera territorios de prueba por prefijo postal si no hay conexión";
        demoBtn.addEventListener("click", () => this.applyDemoTerritories());

        const reloadBtn = document.createElement("button");
        reloadBtn.type = "button";
        reloadBtn.className = "sec-territorios-btn sec-territorios-btn-primary";
        reloadBtn.textContent = "🔄 Sincronizar Dataverse";
        reloadBtn.title = "Recarga maestros de CPs/Territorios y recalcula las OTs sin programar";
        reloadBtn.addEventListener("click", () => {
            void this.refreshDataverseAndRender(true);
        });

        rightGroup.appendChild(this._fileInputEl);
        rightGroup.appendChild(loadLocalBtn);
        rightGroup.appendChild(envToggleBtn);
        rightGroup.appendChild(this._toggleBordersBtn);
        rightGroup.appendChild(this._toggleBadgesBtn);
        rightGroup.appendChild(demoBtn);
        rightGroup.appendChild(reloadBtn);

        toolbar.appendChild(leftGroup);
        toolbar.appendChild(rightGroup);

        // 2. Barra desplegable para configurar URL de entorno externo y Bearer Token
        this._envConfigBarEl = document.createElement("div");
        this._envConfigBarEl.className = "sec-territorios-env-bar";

        const urlLabel = document.createElement("strong");
        urlLabel.textContent = "URL Entorno:";

        this._envUrlInputEl = document.createElement("input");
        this._envUrlInputEl.type = "text";
        this._envUrlInputEl.className = "sec-territorios-input";
        this._envUrlInputEl.placeholder = "Vacío = Entorno actual | Ej: https://org-test.crm4.dynamics.com";

        const tokenLabel = document.createElement("strong");
        tokenLabel.textContent = "Bearer Token:";

        this._envTokenInputEl = document.createElement("input");
        this._envTokenInputEl.type = "password";
        this._envTokenInputEl.className = "sec-territorios-input";
        this._envTokenInputEl.placeholder = "Token OAuth2 del entorno externo";

        const applyEnvBtn = document.createElement("button");
        applyEnvBtn.type = "button";
        applyEnvBtn.className = "sec-territorios-btn sec-territorios-btn-primary";
        applyEnvBtn.textContent = "Aplicar y Consultar";
        applyEnvBtn.addEventListener("click", () => {
            this._manualOverrideEnv = true;
            this._targetEnvUrl = this.normalizeEnvUrl(this._envUrlInputEl.value);
            this._targetAccessToken = this.cleanBearerToken(this._envTokenInputEl.value);
            this.updateEnvironmentBadge();
            void this.refreshDataverseAndRender(false);
        });

        const clearEnvBtn = document.createElement("button");
        clearEnvBtn.type = "button";
        clearEnvBtn.className = "sec-territorios-btn";
        clearEnvBtn.textContent = "Usar Entorno Actual";
        clearEnvBtn.addEventListener("click", () => {
            this._manualOverrideEnv = true;
            this._envUrlInputEl.value = "";
            this._envTokenInputEl.value = "";
            this._targetEnvUrl = "";
            this._targetAccessToken = "";
            this.updateEnvironmentBadge();
            void this.refreshDataverseAndRender(false);
        });

        this._envConfigBarEl.appendChild(urlLabel);
        this._envConfigBarEl.appendChild(this._envUrlInputEl);
        this._envConfigBarEl.appendChild(tokenLabel);
        this._envConfigBarEl.appendChild(this._envTokenInputEl);
        this._envConfigBarEl.appendChild(applyEnvBtn);
        this._envConfigBarEl.appendChild(clearEnvBtn);

        // 3. Cuerpo principal: Escenario del Mapa + Leyenda lateral
        const body = document.createElement("div");
        body.className = "sec-territorios-body";

        this._mapStageEl = document.createElement("div");
        this._mapStageEl.className = "sec-territorios-map-stage";

        this._mapContainerEl = document.createElement("div");
        this._mapContainerEl.className = "sec-territorios-map";

        this._overlayCanvasEl = document.createElement("canvas");
        this._overlayCanvasEl.className = "sec-territorios-overlay-canvas";

        // Controles propios de estilo de mapa (Calles / Oscuro / Satélite) y Zoom
        const mapControls = document.createElement("div");
        mapControls.className = "sec-territorios-map-controls";

        const styleSwitcher = document.createElement("div");
        styleSwitcher.className = "sec-territorios-style-switcher";

        const styles: { mode: MapStyleMode; label: string }[] = [
            { mode: "road", label: "Calles" },
            { mode: "dark", label: "Oscuro" },
            { mode: "satellite", label: "Satélite" }
        ];

        for (const item of styles) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `sec-territorios-style-btn${item.mode === this._currentStyleMode ? " active" : ""}`;
            btn.textContent = item.label;
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this.setMapStyleMode(item.mode);
            });
            this._styleButtons.set(item.mode, btn);
            styleSwitcher.appendChild(btn);
        }

        const zoomGroup = document.createElement("div");
        zoomGroup.className = "sec-territorios-zoom-group";

        const zoomInBtn = document.createElement("button");
        zoomInBtn.type = "button";
        zoomInBtn.className = "sec-territorios-zoom-btn";
        zoomInBtn.textContent = "+";
        zoomInBtn.title = "Acercar";
        zoomInBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this._map) {
                const cam = this._map.getCamera();
                this._map.setCamera({ zoom: (cam.zoom ?? 5.5) + 1, type: "ease", duration: 250 });
            }
        });

        const zoomOutBtn = document.createElement("button");
        zoomOutBtn.type = "button";
        zoomOutBtn.className = "sec-territorios-zoom-btn";
        zoomOutBtn.textContent = "−";
        zoomOutBtn.title = "Alejar";
        zoomOutBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this._map) {
                const cam = this._map.getCamera();
                this._map.setCamera({ zoom: Math.max(2, (cam.zoom ?? 5.5) - 1), type: "ease", duration: 250 });
            }
        });

        zoomGroup.appendChild(zoomInBtn);
        zoomGroup.appendChild(zoomOutBtn);

        mapControls.appendChild(styleSwitcher);
        mapControls.appendChild(zoomGroup);

        // Popup flotante al hacer clic en una zona postal
        this._floatingPopupEl = document.createElement("div");
        this._floatingPopupEl.className = "sec-territorios-floating-popup";

        this._mapStageEl.appendChild(this._mapContainerEl);
        this._mapStageEl.appendChild(this._overlayCanvasEl);
        this._mapStageEl.appendChild(mapControls);
        this._mapStageEl.appendChild(this._floatingPopupEl);

        // Barra lateral derecha de Territorios con los 7 indicadores
        const sidebar = document.createElement("div");
        sidebar.className = "sec-territorios-sidebar";

        const sidebarHeader = document.createElement("div");
        sidebarHeader.className = "sec-territorios-sidebar-header";
        sidebarHeader.innerHTML = "<span>Territorio (Sin Programar)</span><span>7 Métricas</span>";

        this._legendListEl = document.createElement("div");
        this._legendListEl.className = "sec-territorios-legend-list";

        sidebar.appendChild(sidebarHeader);
        sidebar.appendChild(this._legendListEl);

        body.appendChild(this._mapStageEl);
        body.appendChild(sidebar);

        // 4. Etiqueta de versión abajo a la derecha, pequeña y en gris
        const versionEl = document.createElement("div");
        versionEl.className = "sec-territorios-version";
        versionEl.textContent = Territorios.CONTROL_VERSION;

        this._wrapperEl.appendChild(toolbar);
        this._wrapperEl.appendChild(this._envConfigBarEl);
        this._wrapperEl.appendChild(body);
        this._wrapperEl.appendChild(versionEl);
        this._container.appendChild(this._wrapperEl);

        if (typeof ResizeObserver !== "undefined") {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._map && this._mapReady) {
                    this._map.resize();
                    this.scheduleCanvasDraw();
                }
            });
            this._resizeObserver.observe(this._mapStageEl);
        }
    }

    /**
     * Arranca el mapa, la cartografía TopoJSON (con caché IndexedDB) y las consultas
     * a Dataverse EN PARALELO sin esperar en cascada.
     */
    private initializeOrUpdate(context: ComponentFramework.Context<IInputs>): void {
        const apiKey = this.cleanParam(context.parameters.azureMapsKey?.raw);
        const topoUrl = this.cleanParam(context.parameters.topoJsonUrl?.raw);

        if (!this._manualOverrideEnv) {
            const propEnvUrl = this.normalizeEnvUrl(this.cleanParam(context.parameters.targetEnvironmentUrl?.raw));
            const propToken = this.cleanBearerToken(this.cleanParam(context.parameters.targetAccessToken?.raw));

            this._targetEnvUrl = propEnvUrl;
            this._targetAccessToken = propToken;
            this._envUrlInputEl.value = propEnvUrl;
            this._envTokenInputEl.value = propToken;
            this.updateEnvironmentBadge();
        }

        if (!apiKey) {
            this.setStatus("⚠️ Introduce tu 'azureMapsKey' en las propiedades del PCF");
            return;
        }

        // Inicializar el mapa si aún no existe o cambió la clave
        if (!this._map || this._currentKey !== apiKey) {
            this._currentKey = apiKey;
            this.initAzureMap(apiKey);
        }

        // Arranque en paralelo en la primera carga (sin esperar al evento 'ready' del mapa)
        if (!this._initialParallelBootDone) {
            this._initialParallelBootDone = true;
            this._currentTopoUrl = topoUrl;
            void this.bootCartographyAndDataInParallel(topoUrl);
            return;
        }

        // Si cambió la URL del TopoJSON posteriormente
        if (topoUrl && topoUrl !== this._currentTopoUrl) {
            this._currentTopoUrl = topoUrl;
            void this.bootCartographyAndDataInParallel(topoUrl);
        }
    }

    private async bootCartographyAndDataInParallel(topoUrl: string): Promise<void> {
        const tasks: Promise<void>[] = [];

        if (topoUrl) {
            tasks.push(this.loadTopoJsonWithCache(topoUrl));
        } else if (this._preparedPolygons.length === 0) {
            tasks.push(this.tryRestoreLastUsedCartographyFromCache());
        }

        tasks.push(this.loadDataverseDataOnly(false));

        await Promise.all(tasks);
        this.bindTerritoriesToPolygonsAndRender();
    }

    private updateEnvironmentBadge(): void {
        if (this._targetEnvUrl) {
            const host = this._targetEnvUrl.replace(/^https?:\/\//i, "");
            this._envPillEl.textContent = `Entorno Externo: ${host}`;
            this._envPillEl.className = "sec-territorios-env-pill sec-territorios-env-pill-external";
        } else {
            this._envPillEl.textContent = "Entorno: Actual (context.webAPI)";
            this._envPillEl.className = "sec-territorios-env-pill";
        }
    }

    private getAzureTileUrl(tilesetId: string): string {
        return (
            "https://eu.atlas.microsoft.com/map/tile?api-version=2.1" +
            "&tilesetId=" + encodeURIComponent(tilesetId) +
            "&zoom={z}&x={x}&y={y}&tileSize=256" +
            "&language=es-ES&view=Auto" +
            "&subscription-key=" + encodeURIComponent(this._currentKey)
        );
    }

    private setMapStyleMode(mode: MapStyleMode): void {
        this._currentStyleMode = mode;

        this._styleButtons.forEach((btn, key) => {
            if (key === mode) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        });

        if (!this._baseTileLayer || !this._hybridOverlayTileLayer) return;

        if (mode === "road") {
            this._baseTileLayer.setOptions({
                tileUrl: this.getAzureTileUrl("microsoft.base.road"),
                visible: true
            });
            this._hybridOverlayTileLayer.setOptions({ visible: false });
        } else if (mode === "dark") {
            this._baseTileLayer.setOptions({
                tileUrl: this.getAzureTileUrl("microsoft.base.darkgrey"),
                visible: true
            });
            this._hybridOverlayTileLayer.setOptions({ visible: false });
        } else if (mode === "satellite") {
            this._baseTileLayer.setOptions({
                tileUrl: this.getAzureTileUrl("microsoft.imagery"),
                visible: true
            });
            this._hybridOverlayTileLayer.setOptions({
                tileUrl: this.getAzureTileUrl("microsoft.base.hybrid.road"),
                visible: true
            });
        }

        this.scheduleCanvasDraw();
    }

    private initAzureMap(subscriptionKey: string): void {
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }
        this._mapReady = false;

        atlas.setDomain("eu.atlas.microsoft.com");

        this._map = new atlas.Map(this._mapContainerEl, {
            domain: "eu.atlas.microsoft.com",
            center: [-3.7038, 40.2],
            zoom: 5.5,
            language: "es-ES",
            view: "Auto",
            style: "road",
            dragRotate: false,
            pitchWithRotate: false,
            authOptions: {
                authType: atlas.AuthenticationType.subscriptionKey,
                subscriptionKey: subscriptionKey
            }
        });

        this._map.events.add("ready", () => {
            if (!this._map) return;
            this._mapReady = true;
            this._map.resize();

            this._baseTileLayer = new atlas.layer.TileLayer({
                tileUrl: this.getAzureTileUrl("microsoft.base.road"),
                tileSize: 256,
                minSourceZoom: 1,
                maxSourceZoom: 19,
                opacity: 1,
                visible: true
            });

            this._hybridOverlayTileLayer = new atlas.layer.TileLayer({
                tileUrl: this.getAzureTileUrl("microsoft.base.hybrid.road"),
                tileSize: 256,
                minSourceZoom: 1,
                maxSourceZoom: 19,
                opacity: 1,
                visible: false
            });

            this._map.layers.add([this._baseTileLayer, this._hybridOverlayTileLayer]);
            this.setMapStyleMode(this._currentStyleMode);

            // Repintado ligero regulado por requestAnimationFrame (máx. 60 FPS)
            const syncOverlay = (): void => {
                this.scheduleCanvasDraw();
            };

            this._map.events.add("render", syncOverlay);
            this._map.events.add("move", syncOverlay);
            this._map.events.add("zoom", syncOverlay);
            this._map.events.add("moveend", syncOverlay);
            this._map.events.add("resize", syncOverlay);

            this._map.events.add("click", (e) => {
                if (e.position) {
                    this.handleMapClickLonLat(e.position[0], e.position[1]);
                }
            });

            this.scheduleCanvasDraw();
        });
    }

    /**
     * Regula el repintado del <canvas> con requestAnimationFrame para no bloquear el hilo principal al arrastrar el mapa
     */
    private scheduleCanvasDraw(): void {
        if (this._rafId !== null) return;
        this._rafId = window.requestAnimationFrame(() => {
            this._rafId = null;
            this.drawCanvasOverlayNow();
        });
    }

    private toggleInternalBorders(): void {
        this._showInternalBorders = !this._showInternalBorders;
        this._toggleBordersBtn.textContent = this._showInternalBorders
            ? "Bordes CPs: Visibles"
            : "Bordes CPs: Ocultos";
        this.scheduleCanvasDraw();
    }

    private cycleBadgeMode(): void {
        if (this._badgeMode === "compact") {
            this._badgeMode = "full";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: 7 Valores";
        } else if (this._badgeMode === "full") {
            this._badgeMode = "none";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Ocultas";
        } else {
            this._badgeMode = "compact";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Resumen";
        }
        this.scheduleCanvasDraw();
    }

    // =========================================================================
    // CACHÉ EN INDEXEDDB PARA CARTOGRAFÍA Y MAESTROS (CP -> TERRITORIO)
    // =========================================================================

    private openCacheDb(): Promise<IDBDatabase | null> {
        return new Promise((resolve) => {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            try {
                const req = indexedDB.open(IDB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) {
                        db.createObjectStore(IDB_STORE);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    private async idbGet<T>(key: string): Promise<T | null> {
        const db = await this.openCacheDb();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(IDB_STORE, "readonly");
                const store = tx.objectStore(IDB_STORE);
                const req = store.get(key);
                req.onsuccess = () => resolve((req.result as T) ?? null);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    private async idbSet<T>(key: string, value: T): Promise<void> {
        const db = await this.openCacheDb();
        if (!db) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(IDB_STORE, "readwrite");
                const store = tx.objectStore(IDB_STORE);
                store.put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    private async loadTopoJsonWithCache(url: string): Promise<void> {
        const cacheKey = `topo_url_${url}`;
        try {
            const cachedRaw = await this.idbGet<unknown>(cacheKey);
            if (cachedRaw) {
                this.parseCartographyData(cachedRaw);
                return;
            }

            this.setStatus(`Descargando cartografía desde ${url}...`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const rawJson: unknown = await response.json();
            this.parseCartographyData(rawJson);
            void this.idbSet(cacheKey, rawJson);
            void this.idbSet("topo_last_used", rawJson);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setStatus(`⚠️ No se pudo descargar TopoJSON (${msg}). Usa '📂 Cargar TopoJSON'.`);
        }
    }

    private async tryRestoreLastUsedCartographyFromCache(): Promise<void> {
        try {
            const cachedRaw = await this.idbGet<unknown>("topo_last_used");
            if (cachedRaw) {
                this.parseCartographyData(cachedRaw);
            }
        } catch {
            // Sin caché previa de cartografía
        }
    }

    private handleLocalFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (!input.files || input.files.length === 0) return;

        const file = input.files[0];
        this.setStatus(`Leyendo ${file.name}...`);

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const rawJson: unknown = JSON.parse(reader.result as string);
                this.parseCartographyData(rawJson);
                void this.idbSet("topo_last_used", rawJson);

                if (this._territoriesMap.size === 0) {
                    await this.loadDataverseDataOnly(false);
                }
                this.bindTerritoriesToPolygonsAndRender();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.setStatus(`❌ Error al parsear el archivo JSON/TopoJSON: ${msg}`);
            }
        };
        reader.readAsText(file);
    }

    /**
     * Parsea el archivo TopoJSON/GeoJSON e indexa las geometrías originales del TopoJSON por CP
     * para poder fusionarlas por territorio con `topojson.merge()` sin bordes internos.
     */
    private parseCartographyData(rawJson: unknown): void {
        const dataObj = rawJson as { type?: string; objects?: Record<string, GeometryCollection> };
        let rawFeatures: GeoJSON.Feature<GeoJSON.Geometry>[] = [];

        this._rawTopology = null;
        this._topologyObjectKey = "";
        this._cpToTopoGeometries.clear();

        if (dataObj && dataObj.type === "Topology" && dataObj.objects) {
            const objectKeys = Object.keys(dataObj.objects);
            if (objectKeys.length === 0) {
                throw new Error("El archivo TopoJSON no contiene capas en 'objects'.");
            }
            const firstKey = objectKeys[0];
            const firstLayer = dataObj.objects[firstKey];

            this._rawTopology = rawJson as Topology;
            this._topologyObjectKey = firstKey;

            // Indexar cada GeometryObject del TopoJSON por su Código Postal para `topojson.merge`
            const geometries = (firstLayer as { geometries?: GeometryObject[] }).geometries || [];
            for (const geomObj of geometries) {
                const cp = this.extractPostalCodeFromProps(
                    (geomObj.properties || {}) as Record<string, unknown>,
                    geomObj.id
                );
                if (cp) {
                    let list = this._cpToTopoGeometries.get(cp);
                    if (!list) {
                        list = [];
                        this._cpToTopoGeometries.set(cp, list);
                    }
                    list.push(geomObj);
                }
            }

            const converted = topojson.feature(
                this._rawTopology,
                firstLayer
            ) as unknown as GeoJSON.FeatureCollection<GeoJSON.Geometry>;

            rawFeatures = converted.features || [];
        } else if (dataObj && dataObj.type === "FeatureCollection") {
            const fc = rawJson as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
            rawFeatures = fc.features || [];
        } else {
            throw new Error("Formato no reconocido. Debe ser un TopoJSON o GeoJSON válido.");
        }

        this._baseGeoJson = {
            type: "FeatureCollection",
            features: rawFeatures
        };

        this.preparePolygonCache();
    }

    private preparePolygonCache(): void {
        this._preparedPolygons = [];
        if (!this._baseGeoJson) return;

        for (const feat of this._baseGeoJson.features) {
            const geom = feat?.geometry;
            if (!geom) continue;

            const cpCode = this.extractPostalCode(feat);
            const rawRings: number[][][] = [];

            if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
                for (const ring of geom.coordinates) {
                    if (Array.isArray(ring) && ring.length >= 3) {
                        rawRings.push(ring);
                    }
                }
            } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
                for (const poly of geom.coordinates) {
                    if (Array.isArray(poly)) {
                        for (const ring of poly) {
                            if (Array.isArray(ring) && ring.length >= 3) {
                                rawRings.push(ring);
                            }
                        }
                    }
                }
            }

            if (rawRings.length === 0) continue;

            const ringsLonLat: [number, number][][] = [];
            const ringsWorld: [number, number][][] = [];
            let minLon = 180;
            let minLat = 90;
            let maxLon = -180;
            let maxLat = -90;

            for (const ring of rawRings) {
                const llRing: [number, number][] = [];
                const worldRing: [number, number][] = [];

                for (const pt of ring) {
                    const lon = Number(pt[0]);
                    const lat = Number(pt[1]);
                    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

                    llRing.push([lon, lat]);
                    worldRing.push([this.lonToWorldX(lon), this.latToWorldY(lat)]);

                    if (lon < minLon) minLon = lon;
                    if (lat < minLat) minLat = lat;
                    if (lon > maxLon) maxLon = lon;
                    if (lat > maxLat) maxLat = lat;
                }

                if (llRing.length >= 3) {
                    ringsLonLat.push(llRing);
                    ringsWorld.push(worldRing);
                }
            }

            if (ringsWorld.length === 0) continue;

            this._preparedPolygons.push({
                cpCode,
                territoryId: "",
                assigned: false,
                ringsLonLat,
                ringsWorld,
                minLon,
                minLat,
                maxLon,
                maxLat
            });
        }
    }

    // =========================================================================
    // CONSULTAS A DATAVERSE (CACHÉ DE MAESTROS + 4 AGREGADOS EN PARALELO)
    // =========================================================================

    private async queryDataverse(
        entityLogicalName: string,
        entitySetName: string,
        optionsOrNextLink: string,
        maxPageSize?: number
    ): Promise<DataverseQueryResult> {
        if (!this._targetEnvUrl) {
            const queryPart = optionsOrNextLink.startsWith("http")
                ? optionsOrNextLink.substring(optionsOrNextLink.indexOf("?"))
                : optionsOrNextLink;

            const result = await this._context.webAPI.retrieveMultipleRecords(
                entityLogicalName,
                queryPart,
                maxPageSize
            );

            return {
                entities: result.entities as Record<string, unknown>[],
                nextLink: result.nextLink
            };
        }

        const endpointUrl = optionsOrNextLink.startsWith("http")
            ? optionsOrNextLink
            : `${this._targetEnvUrl}/api/data/v9.2/${entitySetName}${optionsOrNextLink}`;

        const preferParts = ['odata.include-annotations="*"'];
        if (maxPageSize && maxPageSize > 0) {
            preferParts.push(`odata.maxpagesize=${maxPageSize}`);
        }

        const headers: Record<string, string> = {
            "Accept": "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            "Prefer": preferParts.join(",")
        };

        if (this._targetAccessToken) {
            headers["Authorization"] = `Bearer ${this._targetAccessToken}`;
        }

        const response = await fetch(endpointUrl, {
            method: "GET",
            headers,
            credentials: this._targetAccessToken ? "omit" : "include"
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    `HTTP ${response.status} en ${this._targetEnvUrl}. Pulsa '🌐 Entorno Externo' y pega un Bearer Token válido.`
                );
            }
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.substring(0, 120)}`);
        }

        const data = (await response.json()) as {
            value?: Record<string, unknown>[];
            "@odata.nextLink"?: string;
        };

        return {
            entities: data.value || [],
            nextLink: data["@odata.nextLink"]
        };
    }

    private createEmptyTerritory(id: string, name: string, color: string): TerritoryInfo {
        return {
            id,
            name,
            color,
            pciExpired: 0,
            pciNotExpired: 0,
            seExpired: 0,
            seNotExpired: 0,
            totalExpired: 0,
            totalNotExpired: 0,
            totalWOs: 0,
            postalCodesCount: 0,
            sumLon: 0,
            sumLat: 0,
            sampleCount: 0,
            minLon: 180,
            minLat: 90,
            maxLon: -180,
            maxLat: -90
        };
    }

    private async refreshDataverseAndRender(forceMasterReload: boolean): Promise<void> {
        await this.loadDataverseDataOnly(forceMasterReload);
        this.bindTerritoriesToPolygonsAndRender();
    }

    /**
     * Carga los maestros (desde caché IndexedDB o Dataverse) y lanza en paralelo
     * las 4 consultas FetchXML con `aggregate="true"` para calcular los 7 valores en ~180 ms
     * sin descargar ni una sola OT individual.
     */
    private async loadDataverseDataOnly(forceMasterReload: boolean): Promise<void> {
        const targetLabel = this._targetEnvUrl ? this._targetEnvUrl : "entorno actual";
        const masterCacheKey = `masters_v1_${this._targetEnvUrl || "local_env"}`;

        try {
            const territoriesMap = new Map<string, TerritoryInfo>();
            const cpToTerritory = new Map<string, string>();

            // 1. Intentar leer Territorios y los ~11.000 Códigos Postales desde caché IndexedDB
            let mastersLoadedFromCache = false;
            if (!forceMasterReload) {
                const cachedMasters = await this.idbGet<CachedMasterData>(masterCacheKey);
                if (
                    cachedMasters &&
                    Date.now() - cachedMasters.timestamp < MASTER_CACHE_TTL_MS &&
                    cachedMasters.cpPairs.length > 0
                ) {
                    for (const t of cachedMasters.territories) {
                        territoriesMap.set(t.id, this.createEmptyTerritory(t.id, t.name, t.color));
                    }
                    for (const [cp, terrId] of cachedMasters.cpPairs) {
                        cpToTerritory.set(cp, terrId);
                    }
                    mastersLoadedFromCache = true;
                }
            }

            // 2. En paralelo: (si no había caché de maestros, descargarlos) + (siempre consultar agregados de OTs)
            const masterPromise = mastersLoadedFromCache
                ? Promise.resolve()
                : this.fetchMastersFromDataverse(targetLabel, masterCacheKey, territoriesMap, cpToTerritory);

            const woAggregatesPromise = this.fetchWorkOrderAggregatesSpain();

            const [, woBuckets] = await Promise.all([masterPromise, woAggregatesPromise]);

            // 3. Volcar las sumas agregadas de los 4 bloques de OTs en cada territorio
            for (const bucket of woBuckets.expiredRows) {
                this.accumulateAggregateRow(territoriesMap, bucket, true);
            }
            for (const bucket of woBuckets.notExpiredRows) {
                this.accumulateAggregateRow(territoriesMap, bucket, false);
            }

            this._territoriesMap = territoriesMap;
            this._cpToTerritoryMap = cpToTerritory;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setStatus(`⚠️ ${msg}`);
        }
    }

    private async fetchMastersFromDataverse(
        targetLabel: string,
        masterCacheKey: string,
        territoriesMap: Map<string, TerritoryInfo>,
        cpToTerritory: Map<string, string>
    ): Promise<void> {
        this.setStatus(`Sincronizando maestros de Territorios y CPs (${targetLabel})...`);

        const territoryQuery = "?$select=territoryid,name&$orderby=name asc";
        const territoryResult = await this.queryDataverse(
            "territory",
            "territories",
            territoryQuery
        );

        territoryResult.entities.forEach((ent, index) => {
            const id = this.cleanGuid(String(ent.territoryid || ""));
            const name = String(ent.name || `Territorio ${index + 1}`);
            const color = TERRITORY_PALETTE[index % TERRITORY_PALETTE.length];

            if (id) {
                territoriesMap.set(id, this.createEmptyTerritory(id, name, color));
            }
        });

        let nextCpQuery =
            "?$select=msdyn_postalcodeid,msdyn_name,_msdyn_serviceterritory_value,statecode" +
            "&$filter=statecode eq 0 and _msdyn_serviceterritory_value ne null" +
            "&$orderby=msdyn_name asc";

        let hasMoreCpPages = true;
        let cpPageCount = 0;

        while (hasMoreCpPages && cpPageCount < 10) {
            cpPageCount++;
            this.setStatus(`Descargando msdyn_postalcode (${targetLabel}) - Página ${cpPageCount}...`);

            const cpResult = await this.queryDataverse(
                "msdyn_postalcode",
                "msdyn_postalcodes",
                nextCpQuery,
                5000
            );

            for (const ent of cpResult.entities) {
                const rawCp = String(ent.msdyn_name || "").trim();
                const rawTerrId =
                    (ent._msdyn_serviceterritory_value as string | undefined) ||
                    (ent.msdyn_serviceterritory as string | undefined);

                if (rawCp && rawTerrId) {
                    const normalizedCp = this.normalizePostalCodeString(rawCp);
                    const cleanTerrId = this.cleanGuid(rawTerrId);
                    cpToTerritory.set(normalizedCp, cleanTerrId);

                    if (!territoriesMap.has(cleanTerrId)) {
                        const formattedName =
                            (ent[
                                "_msdyn_serviceterritory_value@OData.Community.Display.V1.FormattedValue"
                            ] as string | undefined) || `Territorio ${territoriesMap.size + 1}`;
                        const color = TERRITORY_PALETTE[territoriesMap.size % TERRITORY_PALETTE.length];

                        territoriesMap.set(
                            cleanTerrId,
                            this.createEmptyTerritory(cleanTerrId, formattedName, color)
                        );
                    }
                }
            }

            if (cpResult.nextLink) {
                nextCpQuery = cpResult.nextLink;
            } else {
                hasMoreCpPages = false;
            }
        }

        // Guardar maestros en IndexedDB para que las siguientes aperturas sean instantáneas
        if (cpToTerritory.size > 0) {
            const cachePayload: CachedMasterData = {
                timestamp: Date.now(),
                territories: Array.from(territoriesMap.values()).map((t) => ({
                    id: t.id,
                    name: t.name,
                    color: t.color
                })),
                cpPairs: Array.from(cpToTerritory.entries())
            };
            void this.idbSet(masterCacheKey, cachePayload);
        }
    }

    /**
     * Ejecuta en paralelo las consultas FetchXML con `aggregate="true"` que replican
     * exactamente la regla de negocio de España sin descargar registros individuales:
     * - Si tiene `pdw_mmexpirationdate`, evalúa si es <= hoy (caducada) o > hoy (no caducada).
     * - Si `pdw_mmexpirationdate` es null, evalúa `msdyn_timetopromised` <= hoy (caducada) o > hoy / null (no caducada).
     */
    private async fetchWorkOrderAggregatesSpain(): Promise<{
        expiredRows: Record<string, unknown>[];
        notExpiredRows: Record<string, unknown>[];
    }> {
        // Fecha de corte: final del día de hoy (cualquier fecha de hoy o anterior da daysRemaining <= 0)
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);
        const cutoffIso = endOfToday.toISOString();

        const buildAggFetch = (extraConditionsXml: string): string =>
            [
                "<fetch aggregate='true'>",
                "  <entity name='msdyn_workorder'>",
                "    <attribute name='msdyn_workorderid' alias='total_ots' aggregate='count' />",
                "    <attribute name='msdyn_serviceterritory' alias='territory_id' groupby='true' />",
                "    <attribute name='pdw_seorpci' alias='se_or_pci' groupby='true' />",
                "    <filter type='and'>",
                `      <condition attribute='msdyn_systemstatus' operator='eq' value='${UNSCHEDULED_SYSTEM_STATUS}' />`,
                "      <condition attribute='statecode' operator='eq' value='0' />",
                "      <condition attribute='msdyn_serviceterritory' operator='not-null' />",
                extraConditionsXml,
                "    </filter>",
                "  </entity>",
                "</fetch>"
            ].join("");

        // 1. Caducadas por pdw_mmexpirationdate (<= hoy)
        const fetchExpPdw = buildAggFetch(
            `<condition attribute='pdw_mmexpirationdate' operator='not-null' /><condition attribute='pdw_mmexpirationdate' operator='le' value='${cutoffIso}' />`
        );

        // 2. Caducadas por fallback msdyn_timetopromised (cuando pdw_mmexpirationdate es null y msdyn_timetopromised <= hoy)
        const fetchExpFallback = buildAggFetch(
            `<condition attribute='pdw_mmexpirationdate' operator='null' /><condition attribute='msdyn_timetopromised' operator='not-null' /><condition attribute='msdyn_timetopromised' operator='le' value='${cutoffIso}' />`
        );

        // 3. No Caducadas por pdw_mmexpirationdate (> hoy)
        const fetchOkPdw = buildAggFetch(
            `<condition attribute='pdw_mmexpirationdate' operator='not-null' /><condition attribute='pdw_mmexpirationdate' operator='gt' value='${cutoffIso}' />`
        );

        // 4. No Caducadas cuando pdw_mmexpirationdate es null y (msdyn_timetopromised > hoy o es null)
        const fetchOkFallback = buildAggFetch(
            `<condition attribute='pdw_mmexpirationdate' operator='null' /><filter type='or'><condition attribute='msdyn_timetopromised' operator='gt' value='${cutoffIso}' /><condition attribute='msdyn_timetopromised' operator='null' /></filter>`
        );

        const [resExp1, resExp2, resOk1, resOk2] = await Promise.all([
            this.queryDataverse("msdyn_workorder", "msdyn_workorders", `?fetchXml=${encodeURIComponent(fetchExpPdw)}`),
            this.queryDataverse("msdyn_workorder", "msdyn_workorders", `?fetchXml=${encodeURIComponent(fetchExpFallback)}`),
            this.queryDataverse("msdyn_workorder", "msdyn_workorders", `?fetchXml=${encodeURIComponent(fetchOkPdw)}`),
            this.queryDataverse("msdyn_workorder", "msdyn_workorders", `?fetchXml=${encodeURIComponent(fetchOkFallback)}`)
        ]);

        return {
            expiredRows: [...resExp1.entities, ...resExp2.entities],
            notExpiredRows: [...resOk1.entities, ...resOk2.entities]
        };
    }

    private accumulateAggregateRow(
        territoriesMap: Map<string, TerritoryInfo>,
        row: Record<string, unknown>,
        isExpired: boolean
    ): void {
        const rawTerrId =
            (row.territory_id as string | undefined) ||
            (row["_msdyn_serviceterritory_value"] as string | undefined);
        if (!rawTerrId) return;

        const cleanId = this.cleanGuid(rawTerrId);
        const terr = territoriesMap.get(cleanId);
        if (!terr) return;

        const countVal = Number(row.total_ots || 0);
        if (countVal <= 0) return;

        const seOrPciRaw = row.se_or_pci ?? row.pdw_seorpci;
        const seOrPciVal = seOrPciRaw !== undefined && seOrPciRaw !== null ? Number(seOrPciRaw) : null;

        terr.totalWOs += countVal;

        if (isExpired) {
            terr.totalExpired += countVal;
            if (seOrPciVal === PCI_OPTION_VALUE) {
                terr.pciExpired += countVal;
            } else if (seOrPciVal === SE_OPTION_VALUE) {
                terr.seExpired += countVal;
            }
        } else {
            terr.totalNotExpired += countVal;
            if (seOrPciVal === PCI_OPTION_VALUE) {
                terr.pciNotExpired += countVal;
            } else if (seOrPciVal === SE_OPTION_VALUE) {
                terr.seNotExpired += countVal;
            }
        }
    }

    // =========================================================================
    // FUSIÓN TOPOJSON (`topojson.merge`) Y PRE-COMPILACIÓN EN `Path2D`
    // =========================================================================

    private bindTerritoriesToPolygonsAndRender(): void {
        if (this._preparedPolygons.length === 0) {
            return;
        }

        if (this._cpToTerritoryMap.size === 0) {
            this.applyDemoTerritories();
            return;
        }

        this._territoriesMap.forEach((t) => {
            t.postalCodesCount = 0;
            t.sumLon = 0;
            t.sumLat = 0;
            t.sampleCount = 0;
            t.minLon = 180;
            t.minLat = 90;
            t.maxLon = -180;
            t.maxLat = -90;
        });

        let assignedCount = 0;
        let globalExpired = 0;
        let globalNotExpired = 0;
        let globalTotal = 0;

        const polysByTerritory = new Map<string, PreparedPolygon[]>();
        const unassignedPolys: PreparedPolygon[] = [];

        for (const poly of this._preparedPolygons) {
            const territoryId = poly.cpCode ? this._cpToTerritoryMap.get(poly.cpCode) : undefined;
            const territory = territoryId ? this._territoriesMap.get(territoryId) : undefined;

            if (territory) {
                assignedCount++;
                territory.postalCodesCount++;
                poly.assigned = true;
                poly.territoryId = territory.id;

                const centerLon = (poly.minLon + poly.maxLon) * 0.5;
                const centerLat = (poly.minLat + poly.maxLat) * 0.5;

                territory.sumLon += centerLon;
                territory.sumLat += centerLat;
                territory.sampleCount++;

                if (poly.minLon < territory.minLon) territory.minLon = poly.minLon;
                if (poly.minLat < territory.minLat) territory.minLat = poly.minLat;
                if (poly.maxLon > territory.maxLon) territory.maxLon = poly.maxLon;
                if (poly.maxLat > territory.maxLat) territory.maxLat = poly.maxLat;

                let list = polysByTerritory.get(territory.id);
                if (!list) {
                    list = [];
                    polysByTerritory.set(territory.id, list);
                }
                list.push(poly);
            } else {
                poly.assigned = false;
                poly.territoryId = "";
                unassignedPolys.push(poly);
            }
        }

        // Construir los lotes Path2D pre-compilados y fusionados con `topojson.merge`
        this.buildPrecompiledRenderBatches(polysByTerritory, unassignedPolys);

        this._territoriesMap.forEach((t) => {
            globalExpired += t.totalExpired;
            globalNotExpired += t.totalNotExpired;
            globalTotal += t.totalWOs;
        });

        this.renderLegendSidebar();
        this.scheduleCanvasDraw();
        this.setStatus(
            `✅ ${this._territoriesMap.size} terr. | ${assignedCount.toLocaleString("es-ES")} CPs | Cad: ${globalExpired.toLocaleString("es-ES")} · No Cad: ${globalNotExpired.toLocaleString("es-ES")} · TOTAL: ${globalTotal.toLocaleString("es-ES")}`
        );
    }

    /**
     * Une matemáticamente los CPs de cada territorio con `topojson.merge` (eliminando bordes internos)
     * y los compila una sola vez en objetos `Path2D` nativos para que el <canvas> pinte solo 61 objetos en GPU.
     */
    private buildPrecompiledRenderBatches(
        polysByTerritory: Map<string, PreparedPolygon[]>,
        unassignedPolys: PreparedPolygon[]
    ): void {
        this._renderBatches = [];

        if (unassignedPolys.length > 0) {
            const unassignedPath = new Path2D();
            for (const poly of unassignedPolys) {
                this.appendRingsToPath2D(unassignedPath, poly.ringsWorld);
            }
            this._unassignedBatchPath = unassignedPath;
        } else {
            this._unassignedBatchPath = null;
        }

        polysByTerritory.forEach((polys, territoryId) => {
            const terr = this._territoriesMap.get(territoryId);
            if (!terr || polys.length === 0) return;

            // 1. Path detallado con todos los CPs individuales (usado solo si el usuario activa "Bordes CPs: Visibles")
            const detailedPath = new Path2D();
            for (const poly of polys) {
                this.appendRingsToPath2D(detailedPath, poly.ringsWorld);
            }

            // 2. Path fusionado con `topojson.merge`: une los CPs colindantes en un único MultiPolygon por territorio
            let mergedPath: Path2D = detailedPath;
            if (this._rawTopology && this._cpToTopoGeometries.size > 0) {
                const topoGeomsToMerge: GeometryObject[] = [];
                for (const poly of polys) {
                    const geoms = this._cpToTopoGeometries.get(poly.cpCode);
                    if (geoms) {
                        for (const g of geoms) {
                            topoGeomsToMerge.push(g);
                        }
                    }
                }

                if (topoGeomsToMerge.length > 0) {
                    try {
                        const mergedMultiPolygon = topojson.merge(
                            this._rawTopology,
                            topoGeomsToMerge as unknown as (
                                TopoJSON.Polygon | TopoJSON.MultiPolygon
                            )[]
                        );
                        mergedPath = this.buildPath2DFromGeoJsonGeometry(mergedMultiPolygon);
                    } catch {
                        mergedPath = detailedPath;
                    }
                }
            }

            this._renderBatches.push({
                territoryId,
                colorHex: terr.color,
                fillRgba: this.hexToRgba(terr.color, 0.56),
                strokeRgba: this.hexToRgba(terr.color, 0.85),
                mergedPath,
                detailedPath,
                minWx: this.lonToWorldX(terr.minLon),
                minWy: this.latToWorldY(terr.maxLat),
                maxWx: this.lonToWorldX(terr.maxLon),
                maxWy: this.latToWorldY(terr.minLat)
            });
        });
    }

    private buildPath2DFromGeoJsonGeometry(geom: GeoJSON.Geometry): Path2D {
        const path = new Path2D();
        if (geom.type === "Polygon") {
            for (const ring of geom.coordinates) {
                if (ring.length < 3) continue;
                path.moveTo(this.lonToWorldX(ring[0][0]), this.latToWorldY(ring[0][1]));
                for (let i = 1; i < ring.length; i++) {
                    path.lineTo(this.lonToWorldX(ring[i][0]), this.latToWorldY(ring[i][1]));
                }
                path.closePath();
            }
        } else if (geom.type === "MultiPolygon") {
            for (const poly of geom.coordinates) {
                for (const ring of poly) {
                    if (ring.length < 3) continue;
                    path.moveTo(this.lonToWorldX(ring[0][0]), this.latToWorldY(ring[0][1]));
                    for (let i = 1; i < ring.length; i++) {
                        path.lineTo(this.lonToWorldX(ring[i][0]), this.latToWorldY(ring[i][1]));
                    }
                    path.closePath();
                }
            }
        }
        return path;
    }

    private appendRingsToPath2D(path: Path2D, ringsWorld: [number, number][][]): void {
        for (const ring of ringsWorld) {
            if (ring.length < 3) continue;
            path.moveTo(ring[0][0], ring[0][1]);
            for (let i = 1; i < ring.length; i++) {
                path.lineTo(ring[i][0], ring[i][1]);
            }
            path.closePath();
        }
    }

    private applyDemoTerritories(): void {
        if (this._preparedPolygons.length === 0) {
            this.setStatus("⚠️ Primero carga tu archivo TopoJSON con el botón '📂 Cargar TopoJSON'.");
            return;
        }

        const demoDefs = [
            { id: "terr-noroeste", name: "Territorio Noroeste", color: TERRITORY_PALETTE[0], pciExp: 4, pciOk: 5, seExp: 6, seOk: 9, prefixes: ["15", "24", "27", "32", "33", "36"] },
            { id: "terr-norte", name: "Territorio Norte", color: TERRITORY_PALETTE[1], pciExp: 6, pciOk: 9, seExp: 10, seOk: 14, prefixes: ["01", "20", "26", "31", "39", "48", "50", "22", "44"] },
            { id: "terr-noreste", name: "Territorio Noreste", color: TERRITORY_PALETTE[2], pciExp: 12, pciOk: 16, seExp: 19, seOk: 24, prefixes: ["07", "08", "17", "25", "43"] },
            { id: "terr-centro", name: "Territorio Centro", color: TERRITORY_PALETTE[3], pciExp: 15, pciOk: 21, seExp: 25, seOk: 33, prefixes: ["05", "09", "13", "16", "19", "28", "34", "37", "40", "42", "45", "47", "49"] },
            { id: "terr-levante", name: "Territorio Levante", color: TERRITORY_PALETTE[4], pciExp: 8, pciOk: 11, seExp: 11, seOk: 18, prefixes: ["02", "03", "12", "30", "46"] },
            { id: "terr-sur", name: "Territorio Sur y Canarias", color: TERRITORY_PALETTE[5], pciExp: 10, pciOk: 15, seExp: 14, seOk: 24, prefixes: ["04", "06", "10", "11", "14", "18", "21", "23", "29", "35", "38", "41", "51", "52"] }
        ];

        this._territoriesMap.clear();
        this._cpToTerritoryMap.clear();

        for (const def of demoDefs) {
            const totalExp = def.pciExp + def.seExp;
            const totalOk = def.pciOk + def.seOk;
            const info = this.createEmptyTerritory(def.id, def.name, def.color);
            info.pciExpired = def.pciExp;
            info.pciNotExpired = def.pciOk;
            info.seExpired = def.seExp;
            info.seNotExpired = def.seOk;
            info.totalExpired = totalExp;
            info.totalNotExpired = totalOk;
            info.totalWOs = totalExp + totalOk;
            this._territoriesMap.set(def.id, info);
        }

        for (const poly of this._preparedPolygons) {
            if (!poly.cpCode) continue;
            const prefix = poly.cpCode.substring(0, 2);
            const matched = demoDefs.find((d) => d.prefixes.includes(prefix));
            if (matched) {
                this._cpToTerritoryMap.set(poly.cpCode, matched.id);
            }
        }

        this.bindTerritoriesToPolygonsAndRender();
    }

    /**
     * Renderizado ultrarrápido con `Path2D` y `ctx.setTransform`:
     * No recorre vértices en JavaScript durante el movimiento del mapa.
     */
    private drawCanvasOverlayNow(): void {
        if (!this._overlayCanvasEl || !this._mapStageEl || !this._map || !this._mapReady) {
            return;
        }

        const width = this._mapStageEl.clientWidth;
        const height = this._mapStageEl.clientHeight;
        if (width <= 0 || height <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(width * dpr);
        const targetH = Math.round(height * dpr);

        if (this._overlayCanvasEl.width !== targetW || this._overlayCanvasEl.height !== targetH) {
            this._overlayCanvasEl.width = targetW;
            this._overlayCanvasEl.height = targetH;
        }

        const ctx = this._overlayCanvasEl.getContext("2d");
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        if (this._renderBatches.length === 0) {
            return;
        }

        const proj = this.computeScreenProjection(width, height);
        if (!proj) return;

        const { scaleX, offsetX, scaleY, offsetY } = proj;
        const avgScale = (Math.abs(scaleX) + Math.abs(scaleY)) * 0.5 || 1;

        // 1. Aplicar matriz de transformación de coordenadas de mundo -> pantalla directamente en la GPU
        ctx.save();
        ctx.setTransform(
            dpr * scaleX,
            0,
            0,
            dpr * scaleY,
            dpr * offsetX,
            dpr * offsetY
        );

        if (this._unassignedBatchPath) {
            ctx.fillStyle = "rgba(148, 163, 184, 0.18)";
            ctx.fill(this._unassignedBatchPath);
        }

        for (const batch of this._renderBatches) {
            // Descartar territorios enteros que estén fuera de la vista actual
            const bMinX = batch.minWx * scaleX + offsetX;
            const bMaxX = batch.maxWx * scaleX + offsetX;
            const bMinY = batch.minWy * scaleY + offsetY;
            const bMaxY = batch.maxWy * scaleY + offsetY;

            if (bMaxX < -20 || bMinX > width + 20 || bMaxY < -20 || bMinY > height + 20) {
                continue;
            }

            const activePath = this._showInternalBorders ? batch.detailedPath : batch.mergedPath;

            ctx.fillStyle = batch.fillRgba;
            ctx.fill(activePath);

            if (this._showInternalBorders) {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
                ctx.lineWidth = 0.6 / avgScale;
                ctx.stroke(batch.detailedPath);
            } else {
                // Contorno exterior limpio de cada territorio fusionado
                ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
                ctx.lineWidth = 1.2 / avgScale;
                ctx.stroke(batch.mergedPath);
            }
        }

        if (this._selectedCpPath) {
            ctx.strokeStyle = "#0f172a";
            ctx.lineWidth = 2.2 / avgScale;
            ctx.stroke(this._selectedCpPath);
        }

        ctx.restore();

        // 2. Pintar las etiquetas en coordenadas de píxel de pantalla
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (this._badgeMode !== "none") {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            this._territoriesMap.forEach((terr) => {
                if (terr.sampleCount <= 0) return;

                const centerLon = terr.sumLon / terr.sampleCount;
                const centerLat = terr.sumLat / terr.sampleCount;
                const cx = this.lonToWorldX(centerLon) * scaleX + offsetX;
                const cy = this.latToWorldY(centerLat) * scaleY + offsetY;

                if (cx < -80 || cx > width + 80 || cy < -50 || cy > height + 50) {
                    return;
                }

                if (this._badgeMode === "compact") {
                    const label = `Tot:${terr.totalWOs} | Cad:${terr.totalExpired}`;
                    ctx.font = "700 10px 'Segoe UI', sans-serif";
                    const textW = ctx.measureText(label).width;
                    const pillW = Math.max(54, textW + 14);
                    const pillH = 22;

                    this.drawRoundedRect(ctx, cx - pillW / 2, cy - pillH / 2, pillW, pillH, 11);
                    ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
                    ctx.fill();
                    ctx.strokeStyle = terr.color;
                    ctx.lineWidth = 2.2;
                    ctx.stroke();

                    ctx.fillStyle = "#ffffff";
                    ctx.fillText(label, cx, cy + 0.5);
                } else {
                    const line1 = terr.name.length > 20 ? terr.name.substring(0, 19) + "…" : terr.name;
                    const line2 = `PCI Cad:${terr.pciExpired} OK:${terr.pciNotExpired} | SE Cad:${terr.seExpired} OK:${terr.seNotExpired}`;
                    const line3 = `Cad: ${terr.totalExpired} · No Cad: ${terr.totalNotExpired} · TOTAL: ${terr.totalWOs}`;

                    ctx.font = "700 11px 'Segoe UI', sans-serif";
                    const w1 = ctx.measureText(line1).width;
                    ctx.font = "600 9.5px 'Segoe UI', sans-serif";
                    const w2 = ctx.measureText(line2).width;
                    const w3 = ctx.measureText(line3).width;

                    const pillW = Math.max(w1, w2, w3) + 18;
                    const pillH = 48;

                    this.drawRoundedRect(ctx, cx - pillW / 2, cy - pillH / 2, pillW, pillH, 8);
                    ctx.fillStyle = "rgba(15, 23, 42, 0.93)";
                    ctx.fill();
                    ctx.strokeStyle = terr.color;
                    ctx.lineWidth = 2.2;
                    ctx.stroke();

                    ctx.font = "700 11px 'Segoe UI', sans-serif";
                    ctx.fillStyle = "#ffffff";
                    ctx.fillText(line1, cx, cy - 13);

                    ctx.font = "600 9.5px 'Segoe UI', sans-serif";
                    ctx.fillStyle = "#cbd5e1";
                    ctx.fillText(line2, cx, cy + 1);

                    ctx.font = "700 9.5px 'Segoe UI', sans-serif";
                    ctx.fillStyle = "#fca5a5";
                    ctx.fillText(line3, cx, cy + 14);
                }
            });
        }

        if (this._popupPositionLonLat && this._floatingPopupEl.classList.contains("open")) {
            const px = this.lonToWorldX(this._popupPositionLonLat[0]) * scaleX + offsetX;
            const py = this.latToWorldY(this._popupPositionLonLat[1]) * scaleY + offsetY;
            this._floatingPopupEl.style.left = `${px}px`;
            this._floatingPopupEl.style.top = `${py}px`;
        }

        ctx.restore();
    }

    private computeScreenProjection(
        width: number,
        height: number
    ): { scaleX: number; offsetX: number; scaleY: number; offsetY: number } | null {
        if (!this._map) return null;

        try {
            const pixels = this._map.positionsToPixels([this._refPoint1, this._refPoint2]);
            if (pixels && pixels.length === 2) {
                const p1 = pixels[0];
                const p2 = pixels[1];
                const dWx = this._refWorld2[0] - this._refWorld1[0];
                const dWy = this._refWorld2[1] - this._refWorld1[1];

                if (Math.abs(dWx) > 1e-6 && Math.abs(dWy) > 1e-6) {
                    const scaleX = (p2[0] - p1[0]) / dWx;
                    const scaleY = (p2[1] - p1[1]) / dWy;
                    if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && Math.abs(scaleX) > 1e-5) {
                        return {
                            scaleX,
                            offsetX: p1[0] - this._refWorld1[0] * scaleX,
                            scaleY,
                            offsetY: p1[1] - this._refWorld1[1] * scaleY
                        };
                    }
                }
            }
        } catch {
            // Fallback por cámara si positionsToPixels no está disponible en el primer fotograma
        }

        const cam = this._map.getCamera();
        const center = cam.center || [-3.7038, 40.2];
        const zoom = cam.zoom ?? 5.5;
        const mapPixelSize = 512 * Math.pow(2, zoom);
        const scale = mapPixelSize / WORLD_SIZE;
        const centerWx = this.lonToWorldX(center[0]);
        const centerWy = this.latToWorldY(center[1]);

        return {
            scaleX: scale,
            offsetX: width * 0.5 - centerWx * scale,
            scaleY: scale,
            offsetY: height * 0.5 - centerWy * scale
        };
    }

    private handleMapClickLonLat(lon: number, lat: number): void {
        let hitPoly: PreparedPolygon | null = null;

        for (const poly of this._preparedPolygons) {
            if (lon < poly.minLon || lon > poly.maxLon || lat < poly.minLat || lat > poly.maxLat) {
                continue;
            }
            for (const ring of poly.ringsLonLat) {
                if (this.isPointInRing(lon, lat, ring)) {
                    hitPoly = poly;
                    break;
                }
            }
            if (hitPoly) break;
        }

        if (!hitPoly) {
            this._selectedCpPolygon = null;
            this._selectedCpPath = null;
            this._popupPositionLonLat = null;
            this._floatingPopupEl.classList.remove("open");
            this.scheduleCanvasDraw();
            return;
        }

        this._selectedCpPolygon = hitPoly;
        const selPath = new Path2D();
        this.appendRingsToPath2D(selPath, hitPoly.ringsWorld);
        this._selectedCpPath = selPath;
        this._popupPositionLonLat = [lon, lat];

        const terr = hitPoly.territoryId ? this._territoriesMap.get(hitPoly.territoryId) : undefined;
        const terrName = terr ? terr.name : "Sin territorio asignado";
        const terrColor = terr ? terr.color : "#94a3b8";
        const totalCps = terr ? terr.postalCodesCount : 0;

        const pciExp = terr ? terr.pciExpired : 0;
        const pciOk = terr ? terr.pciNotExpired : 0;
        const seExp = terr ? terr.seExpired : 0;
        const seOk = terr ? terr.seNotExpired : 0;
        const totExp = terr ? terr.totalExpired : 0;
        const totOk = terr ? terr.totalNotExpired : 0;
        const totAll = terr ? terr.totalWOs : 0;

        this._floatingPopupEl.innerHTML = `
            <div class="sec-territorios-popup-header">
                <div class="sec-territorios-popup-title">
                    <span class="sec-territorios-color-dot" style="background:${terrColor}"></span>
                    <span>${terrName}</span>
                </div>
                <button type="button" class="sec-territorios-popup-close" title="Cerrar">✕</button>
            </div>
            <div><strong>Código Postal:</strong> ${hitPoly.cpCode || "N/D"} (${totalCps.toLocaleString("es-ES")} CPs en territorio)</div>
            <div class="sec-territorios-popup-grid">
                <div class="sec-territorios-metric-pill sec-territorios-metric-expired">
                    <span>PCI Caducadas:</span><span>${pciExp}</span>
                </div>
                <div class="sec-territorios-metric-pill sec-territorios-metric-ok">
                    <span>PCI No Cad.:</span><span>${pciOk}</span>
                </div>
                <div class="sec-territorios-metric-pill sec-territorios-metric-expired">
                    <span>SE Caducadas:</span><span>${seExp}</span>
                </div>
                <div class="sec-territorios-metric-pill sec-territorios-metric-ok">
                    <span>SE No Cad.:</span><span>${seOk}</span>
                </div>
                <div class="sec-territorios-metric-pill sec-territorios-metric-total-exp">
                    <span>Total Caducadas:</span><span>${totExp}</span>
                </div>
                <div class="sec-territorios-metric-pill sec-territorios-metric-total-ok">
                    <span>Total No Cad.:</span><span>${totOk}</span>
                </div>
                <div class="sec-territorios-popup-total-row">
                    <span>TOTAL OTs Sin Programar:</span>
                    <span class="sec-territorios-badge-total">${totAll}</span>
                </div>
            </div>
        `;

        const closeBtn = this._floatingPopupEl.querySelector(".sec-territorios-popup-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this._selectedCpPolygon = null;
                this._selectedCpPath = null;
                this._popupPositionLonLat = null;
                this._floatingPopupEl.classList.remove("open");
                this.scheduleCanvasDraw();
            });
        }

        this._floatingPopupEl.classList.add("open");
        this.scheduleCanvasDraw();
    }

    private isPointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];

            const intersect =
                yi > lat !== yj > lat &&
                lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    private renderLegendSidebar(): void {
        this._legendListEl.innerHTML = "";
        const fragment = document.createDocumentFragment();

        this._territoriesMap.forEach((terr) => {
            const item = document.createElement("div");
            item.className = "sec-territorios-legend-item";
            item.title = "Haz clic para centrar el mapa en este territorio";

            item.innerHTML = `
                <div class="sec-territorios-legend-top">
                    <div class="sec-territorios-legend-left">
                        <span class="sec-territorios-color-dot" style="background-color: ${terr.color}"></span>
                        <div>
                            <div class="sec-territorios-legend-name">${terr.name}</div>
                            <div class="sec-territorios-legend-sub">${terr.postalCodesCount.toLocaleString("es-ES")} CPs asignados</div>
                        </div>
                    </div>
                    <span class="sec-territorios-badge-total" title="7. TOTAL OTs sin programar">TOTAL: ${terr.totalWOs}</span>
                </div>
                <div class="sec-territorios-metrics-grid">
                    <div class="sec-territorios-metric-pill sec-territorios-metric-expired" title="1. PCI Caducadas (<= 0 días)">
                        <span>PCI Cad:</span><span>${terr.pciExpired}</span>
                    </div>
                    <div class="sec-territorios-metric-pill sec-territorios-metric-ok" title="2. PCI No Caducadas (> 0 días)">
                        <span>PCI No Cad:</span><span>${terr.pciNotExpired}</span>
                    </div>
                    <div class="sec-territorios-metric-pill sec-territorios-metric-expired" title="3. SE Caducadas (<= 0 días)">
                        <span>SE Cad:</span><span>${terr.seExpired}</span>
                    </div>
                    <div class="sec-territorios-metric-pill sec-territorios-metric-ok" title="4. SE No Caducadas (> 0 días)">
                        <span>SE No Cad:</span><span>${terr.seNotExpired}</span>
                    </div>
                    <div class="sec-territorios-metric-pill sec-territorios-metric-total-exp" title="5. Total Caducadas">
                        <span>Tot. Cad:</span><span>${terr.totalExpired}</span>
                    </div>
                    <div class="sec-territorios-metric-pill sec-territorios-metric-total-ok" title="6. Total No Caducadas">
                        <span>Tot. No Cad:</span><span>${terr.totalNotExpired}</span>
                    </div>
                </div>
            `;

            item.addEventListener("click", () => {
                if (this._map && terr.sampleCount > 0) {
                    this._map.setCamera({
                        bounds: [terr.minLon - 0.25, terr.minLat - 0.25, terr.maxLon + 0.25, terr.maxLat + 0.25],
                        padding: 40,
                        type: "ease",
                        duration: 600
                    });
                }
            });

            fragment.appendChild(item);
        });

        this._legendListEl.appendChild(fragment);
    }

    private extractPostalCode(feature: GeoJSON.Feature): string {
        return this.extractPostalCodeFromProps(
            (feature.properties || {}) as Record<string, unknown>,
            feature.id
        );
    }

    private extractPostalCodeFromProps(
        props: Record<string, unknown>,
        fallbackId?: string | number
    ): string {
        let raw: unknown =
            props.COD_POSTAL ??
            props.cod_postal ??
            props.CP ??
            props.cp ??
            props.postalcode ??
            props.codigo_postal ??
            props.msdyn_name ??
            fallbackId;

        if (raw === undefined || raw === null || raw === "") {
            for (const val of Object.values(props)) {
                const candidate = String(val ?? "").trim();
                if (/^\d{4,5}\$/.test(candidate)) {
                    raw = candidate;
                    break;
                }
            }
        }

        return this.normalizePostalCodeString(String(raw ?? ""));
    }

    private normalizePostalCodeString(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return "";
        const digitsMatch = trimmed.match(/\d+/);
        if (!digitsMatch) return trimmed;
        return digitsMatch[0].padStart(5, "0");
    }

    private lonToWorldX(lon: number): number {
        return ((lon + 180) / 360) * WORLD_SIZE;
    }

    private latToWorldY(lat: number): number {
        const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const sinLat = Math.sin((clamped * Math.PI) / 180);
        const mercY = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
        return mercY * WORLD_SIZE;
    }

    private hexToRgba(hex: string, alpha: number): string {
        const clean = hex.replace("#", "");
        const num = parseInt(clean, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    private drawRoundedRect(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        w: number,
        h: number,
        r: number
    ): void {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    private cleanParam(val: string | null | undefined): string {
        const trimmed = (val || "").trim();
        return trimmed === "val" ? "" : trimmed;
    }

    private normalizeEnvUrl(url: string): string {
        const trimmed = url.trim().replace(/\/+\$/, "");
        if (!trimmed) return "";
        return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    }

    private cleanBearerToken(token: string): string {
        return token.trim().replace(/^Bearer\s+/i, "");
    }

    private cleanGuid(guid: string): string {
        return guid.replace(/[{}]/g, "").toLowerCase();
    }

    private setStatus(text: string): void {
        if (this._statusEl) {
            this._statusEl.textContent = text;
        }
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        if (this._rafId !== null) {
            window.cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }
    }
}
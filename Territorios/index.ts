import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as atlas from "azure-maps-control";
import * as topojson from "topojson-client";
import { Topology, GeometryCollection } from "topojson-specification";

interface TerritoryInfo {
    id: string;
    name: string;
    color: string;
    pendingWOs: number;
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
    ringsMercator: [number, number][][];
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
    minMx: number;
    minMy: number;
    maxMx: number;
    maxMy: number;
}

interface DataverseQueryResult {
    entities: Record<string, unknown>[];
    nextLink?: string;
}

type MapStyleMode = "road" | "dark" | "satellite";
type BadgeDisplayMode = "full" | "compact" | "none";

// Paleta de 20 colores diferenciados de alto contraste para distinguir cada territorio
const TERRITORY_PALETTE: string[] = [
    "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
    "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5",
    "#0d9488", "#c026d3", "#ca8a04", "#e11d48", "#0284c7",
    "#15803d", "#9333ea", "#b45309", "#0369a1", "#be123c"
];

export class Territorios implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private static readonly CONTROL_VERSION = "v0.0.7";

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
    private _popupPositionLonLat: [number, number] | null = null;

    private _baseGeoJson: GeoJSON.FeatureCollection<GeoJSON.Geometry> | null = null;
    private _preparedPolygons: PreparedPolygon[] = [];
    private _cpToTerritoryMap: Map<string, string> = new Map<string, string>();
    private _territoriesMap: Map<string, TerritoryInfo> = new Map<string, TerritoryInfo>();

    // Puntos de referencia en España para sincronizar proyección Web Mercator con Azure Maps
    private readonly _refPoint1: [number, number] = [-9.5, 43.8];
    private readonly _refPoint2: [number, number] = [3.5, 36.0];
    private readonly _refMerc1: [number, number];
    private readonly _refMerc2: [number, number];

    constructor() {
        this._refMerc1 = [this.lonToMercatorX(this._refPoint1[0]), this.latToMercatorY(this._refPoint1[1])];
        this._refMerc2 = [this.lonToMercatorX(this._refPoint2[0]), this.latToMercatorY(this._refPoint2[1])];
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
        this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Nº OTs";
        this._toggleBadgesBtn.title = "Alternar visualización de burbujas de OTs sobre el mapa";
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
        reloadBtn.addEventListener("click", () => {
            void this.refreshDataverseAndRender();
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
            void this.refreshDataverseAndRender();
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
            void this.refreshDataverseAndRender();
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

        // Controles propios de estilo de mapa (Calles / Oscuro / Satélite) y Zoom que funcionan sobre TileLayer
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

        // Barra lateral derecha de Territorios
        const sidebar = document.createElement("div");
        sidebar.className = "sec-territorios-sidebar";

        const sidebarHeader = document.createElement("div");
        sidebarHeader.className = "sec-territorios-sidebar-header";
        sidebarHeader.innerHTML = "<span>Territorio</span><span>OTs Pend.</span>";

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
                    this.drawCanvasOverlay();
                }
            });
            this._resizeObserver.observe(this._mapStageEl);
        }
    }

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

        if (!this._map || this._currentKey !== apiKey) {
            this._currentKey = apiKey;
            this.initAzureMap(apiKey, topoUrl);
            return;
        }

        if (topoUrl && topoUrl !== this._currentTopoUrl) {
            this._currentTopoUrl = topoUrl;
            void this.loadTopoJsonFromUrl(topoUrl);
        }
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

    /**
     * Construye la URL oficial de teselas rasterizadas de Azure Maps en el dominio europeo
     * tal y como se implementó en "Integración de Mapas en PCF" (SecuRutas).
     */
    private getAzureTileUrl(tilesetId: string): string {
        return (
            "https://eu.atlas.microsoft.com/map/tile?api-version=2.1" +
            "&tilesetId=" + encodeURIComponent(tilesetId) +
            "&zoom={z}&x={x}&y={y}&tileSize=256" +
            "&language=es-ES&view=Auto" +
            "&subscription-key=" + encodeURIComponent(this._currentKey)
        );
    }

    /**
     * Cambia dinámicamente el tipo de mapa (Calles / Oscuro / Satélite) actualizando el TileLayer
     */
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

        this.drawCanvasOverlay();
    }

    private initAzureMap(subscriptionKey: string, topoUrl: string): void {
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }
        this._mapReady = false;

        this.setStatus("Iniciando Azure Maps (Región EU)...");

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

            // Inyectamos el TileLayer rasterizado oficial de Azure Maps (evita el fallo WebGL de teselas vectoriales)
            this._baseTileLayer = new atlas.layer.TileLayer({
                tileUrl: this.getAzureTileUrl("microsoft.base.road"),
                tileSize: 256,
                minSourceZoom: 1,
                maxSourceZoom: 19,
                opacity: 1,
                visible: true
            });

            // Capa secundaria para superponer carreteras y nombres sobre la ortofoto satélite
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

            // Sincronizar el lienzo <canvas> de polígonos y burbujas en cada movimiento/render del mapa
            const syncOverlay = (): void => {
                this.drawCanvasOverlay();
            };

            this._map.events.add("render", syncOverlay);
            this._map.events.add("move", syncOverlay);
            this._map.events.add("zoom", syncOverlay);
            this._map.events.add("moveend", syncOverlay);
            this._map.events.add("resize", syncOverlay);

            // Detectar clic sobre cualquier código postal para mostrar el popup con datos del territorio
            this._map.events.add("click", (e) => {
                if (e.position) {
                    const lon = e.position[0];
                    const lat = e.position[1];
                    this.handleMapClickLonLat(lon, lat);
                }
            });

            if (topoUrl) {
                this._currentTopoUrl = topoUrl;
                void this.loadTopoJsonFromUrl(topoUrl);
            } else if (this._baseGeoJson) {
                void this.refreshDataverseAndRender();
            } else {
                this.setStatus("Mapa listo. Pulsa '📂 Cargar TopoJSON' o configura 'topoJsonUrl'.");
                void this.refreshDataverseAndRender();
            }
        });
    }

    private toggleInternalBorders(): void {
        this._showInternalBorders = !this._showInternalBorders;
        this._toggleBordersBtn.textContent = this._showInternalBorders
            ? "Bordes CPs: Visibles"
            : "Bordes CPs: Ocultos";
        this.drawCanvasOverlay();
    }

    private cycleBadgeMode(): void {
        if (this._badgeMode === "compact") {
            this._badgeMode = "full";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Completas";
        } else if (this._badgeMode === "full") {
            this._badgeMode = "none";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Ocultas";
        } else {
            this._badgeMode = "compact";
            this._toggleBadgesBtn.textContent = "🏷️ Etiquetas: Nº OTs";
        }
        this.drawCanvasOverlay();
    }

    /**
     * ENRUTADOR HÍBRIDO DE CONSULTAS A DATAVERSE:
     * - Si `_targetEnvUrl` está vacío -> Usa `this._context.webAPI.retrieveMultipleRecords` (entorno actual).
     * - Si `_targetEnvUrl` tiene valor -> Hace petición `fetch()` directa a `https://<entorno>/api/data/v9.2/<entitySetName>`.
     */
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

    private async loadTopoJsonFromUrl(url: string): Promise<void> {
        try {
            this.setStatus(`Descargando cartografía desde ${url}...`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const rawJson: unknown = await response.json();
            this.parseCartographyData(rawJson);
            await this.refreshDataverseAndRender();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setStatus(`⚠️ No se pudo descargar TopoJSON (${msg}). Usa '📂 Cargar TopoJSON'.`);
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
                await this.refreshDataverseAndRender();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.setStatus(`❌ Error al parsear el archivo JSON/TopoJSON: ${msg}`);
            }
        };
        reader.readAsText(file);
    }

    private parseCartographyData(rawJson: unknown): void {
        const dataObj = rawJson as { type?: string; objects?: Record<string, GeometryCollection> };
        let rawFeatures: GeoJSON.Feature<GeoJSON.Geometry>[] = [];

        if (dataObj.type === "Topology" && dataObj.objects) {
            const objectKeys = Object.keys(dataObj.objects);
            if (objectKeys.length === 0) {
                throw new Error("El archivo TopoJSON no contiene capas en 'objects'.");
            }
            const firstLayer = dataObj.objects[objectKeys[0]];
            const converted = topojson.feature(
                rawJson as Topology,
                firstLayer
            ) as unknown as GeoJSON.FeatureCollection<GeoJSON.Geometry>;

            rawFeatures = converted.features || [];
        } else if (dataObj.type === "FeatureCollection") {
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
        this.setStatus(`Cartografía lista: ${this._preparedPolygons.length.toLocaleString("es-ES")} polígonos cargados.`);
    }

    /**
     * Precalcula los anillos y coordenadas Web Mercator de cada polígono una sola vez
     * para pintarlos en el <canvas> a 60 FPS sin depender del WebWorker de Azure Maps.
     */
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
            const ringsMercator: [number, number][][] = [];
            let minLon = 180;
            let minLat = 90;
            let maxLon = -180;
            let maxLat = -90;

            for (const ring of rawRings) {
                const llRing: [number, number][] = [];
                const mercRing: [number, number][] = [];

                for (const pt of ring) {
                    const lon = Number(pt[0]);
                    const lat = Number(pt[1]);
                    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

                    llRing.push([lon, lat]);
                    mercRing.push([this.lonToMercatorX(lon), this.latToMercatorY(lat)]);

                    if (lon < minLon) minLon = lon;
                    if (lat < minLat) minLat = lat;
                    if (lon > maxLon) maxLon = lon;
                    if (lat > maxLat) maxLat = lat;
                }

                if (llRing.length >= 3) {
                    ringsLonLat.push(llRing);
                    ringsMercator.push(mercRing);
                }
            }

            if (ringsMercator.length === 0) continue;

            this._preparedPolygons.push({
                cpCode,
                territoryId: "",
                assigned: false,
                ringsLonLat,
                ringsMercator,
                minLon,
                minLat,
                maxLon,
                maxLat,
                minMx: this.lonToMercatorX(minLon),
                minMy: this.latToMercatorY(maxLat),
                maxMx: this.lonToMercatorX(maxLon),
                maxMy: this.latToMercatorY(minLat)
            });
        }
    }

    /**
     * Consulta en Dataverse sin ningún escape '\$' innecesario en las cadenas OData:
     * - territory: territoryid, name
     * - msdyn_postalcode: msdyn_postalcodeid, msdyn_name, _msdyn_serviceterritory_value (statecode eq 0)
     * - msdyn_workorder: suma agregada por msdyn_serviceterritory (msdyn_systemstatus = 690970000, statecode = 0)
     */
    private async refreshDataverseAndRender(): Promise<void> {
        const targetLabel = this._targetEnvUrl ? this._targetEnvUrl : "entorno actual";

        try {
            this.setStatus(`Consultando territorios, CPs y OTs en ${targetLabel}...`);

            const territoriesMap = new Map<string, TerritoryInfo>();
            const cpToTerritory = new Map<string, string>();

            // 1. Consultar Territorios (sin escapes innecesarios en $select ni$orderby)
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
                    territoriesMap.set(id, {
                        id,
                        name,
                        color,
                        pendingWOs: 0,
                        postalCodesCount: 0,
                        sumLon: 0,
                        sumLat: 0,
                        sampleCount: 0,
                        minLon: 180,
                        minLat: 90,
                        maxLon: -180,
                        maxLat: -90
                    });
                }
            });

            // 2. Consultar Códigos Postales con los nombres exactos del FetchXML
            let nextQueryOrUrl =
                "?$select=msdyn_postalcodeid,msdyn_name,_msdyn_serviceterritory_value,statecode" +
                "&$filter=statecode eq 0 and _msdyn_serviceterritory_value ne null" +
                "&$orderby=msdyn_name asc";

            let hasMorePages = true;
            let pageCount = 0;

            while (hasMorePages && pageCount < 10) {
                pageCount++;
                this.setStatus(`Descargando msdyn_postalcode (${targetLabel}) - Página ${pageCount}...`);

                const cpResult = await this.queryDataverse(
                    "msdyn_postalcode",
                    "msdyn_postalcodes",
                    nextQueryOrUrl,
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

                            territoriesMap.set(cleanTerrId, {
                                id: cleanTerrId,
                                name: formattedName,
                                color,
                                pendingWOs: 0,
                                postalCodesCount: 0,
                                sumLon: 0,
                                sumLat: 0,
                                sampleCount: 0,
                                minLon: 180,
                                minLat: 90,
                                maxLon: -180,
                                maxLat: -90
                            });
                        }
                    }
                }

                if (cpResult.nextLink) {
                    nextQueryOrUrl = cpResult.nextLink;
                } else {
                    hasMorePages = false;
                }
            }

            // 3. Consultar suma agregada de OTs pendientes de programar (msdyn_systemstatus = 690970000)
            const aggregateFetchXml = [
                "<fetch aggregate='true'>",
                "  <entity name='msdyn_workorder'>",
                "    <attribute name='msdyn_workorderid' alias='total_ots' aggregate='count' />",
                "    <attribute name='msdyn_serviceterritory' alias='territory_id' groupby='true' />",
                "    <filter type='and'>",
                "      <condition attribute='msdyn_systemstatus' operator='eq' value='690970000' />",
                "      <condition attribute='statecode' operator='eq' value='0' />",
                "      <condition attribute='msdyn_serviceterritory' operator='not-null' />",
                "    </filter>",
                "  </entity>",
                "</fetch>"
            ].join("");

            const woResult = await this.queryDataverse(
                "msdyn_workorder",
                "msdyn_workorders",
                `?fetchXml=${encodeURIComponent(aggregateFetchXml)}`
            );

            for (const row of woResult.entities) {
                const rawTerrId =
                    (row.territory_id as string) ||
                    (row["_msdyn_serviceterritory_value"] as string);
                const countVal = Number(row.total_ots || 0);
                if (rawTerrId) {
                    const cleanId = this.cleanGuid(rawTerrId);
                    const terr = territoriesMap.get(cleanId);
                    if (terr) {
                        terr.pendingWOs = countVal;
                    }
                }
            }

            this._territoriesMap = territoriesMap;
            this._cpToTerritoryMap = cpToTerritory;

            if (this._cpToTerritoryMap.size === 0 && this._preparedPolygons.length > 0) {
                this.applyDemoTerritories();
            } else {
                this.bindTerritoriesToPolygonsAndRender();
            }
        } catch (err) {
            if (this._preparedPolygons.length > 0 && this._cpToTerritoryMap.size === 0) {
                this.applyDemoTerritories();
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                this.setStatus(`⚠️ ${msg}`);
            }
        }
    }

    private applyDemoTerritories(): void {
        if (this._preparedPolygons.length === 0) {
            this.setStatus("⚠️ Primero carga tu archivo TopoJSON con el botón '📂 Cargar TopoJSON'.");
            return;
        }

        const demoDefs = [
            { id: "terr-noroeste", name: "Territorio Noroeste", color: TERRITORY_PALETTE[0], pendingWOs: 24, prefixes: ["15", "24", "27", "32", "33", "36"] },
            { id: "terr-norte", name: "Territorio Norte", color: TERRITORY_PALETTE[1], pendingWOs: 39, prefixes: ["01", "20", "26", "31", "39", "48", "50", "22", "44"] },
            { id: "terr-noreste", name: "Territorio Noreste", color: TERRITORY_PALETTE[2], pendingWOs: 71, prefixes: ["07", "08", "17", "25", "43"] },
            { id: "terr-centro", name: "Territorio Centro", color: TERRITORY_PALETTE[3], pendingWOs: 94, prefixes: ["05", "09", "13", "16", "19", "28", "34", "37", "40", "42", "45", "47", "49"] },
            { id: "terr-levante", name: "Territorio Levante", color: TERRITORY_PALETTE[4], pendingWOs: 48, prefixes: ["02", "03", "12", "30", "46"] },
            { id: "terr-sur", name: "Territorio Sur y Canarias", color: TERRITORY_PALETTE[5], pendingWOs: 63, prefixes: ["04", "06", "10", "11", "14", "18", "21", "23", "29", "35", "38", "41", "51", "52"] }
        ];

        this._territoriesMap.clear();
        this._cpToTerritoryMap.clear();

        for (const def of demoDefs) {
            this._territoriesMap.set(def.id, {
                id: def.id,
                name: def.name,
                color: def.color,
                pendingWOs: def.pendingWOs,
                postalCodesCount: 0,
                sumLon: 0,
                sumLat: 0,
                sampleCount: 0,
                minLon: 180,
                minLat: 90,
                maxLon: -180,
                maxLat: -90
            });
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
     * Vincula cada polígono de código postal con su territorio de Dataverse,
     * calcula los límites geográficos de cada territorio y lanza el pintado en el <canvas>.
     */
    private bindTerritoriesToPolygonsAndRender(): void {
        if (this._preparedPolygons.length === 0) {
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
            } else {
                poly.assigned = false;
                poly.territoryId = "";
            }
        }

        this.renderLegendSidebar();
        this.drawCanvasOverlay();
        this.setStatus(
            `✅ ${this._territoriesMap.size} territorios | ${assignedCount.toLocaleString("es-ES")} CPs pintados`
        );
    }

    /**
     * Pinta los 10.874 polígonos agrupados por territorio y los indicadores de OTs
     * directamente en el <canvas> 2D sincronizado con la cámara de Azure Maps.
     */
    private drawCanvasOverlay(): void {
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

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        if (this._preparedPolygons.length === 0) {
            ctx.restore();
            return;
        }

        // Obtener factor de escala exacto desde positionsToPixels de Azure Maps
        const proj = this.computeScreenProjection(width, height);
        if (!proj) {
            ctx.restore();
            return;
        }

        const { scaleX, offsetX, scaleY, offsetY } = proj;

        // 1. Agrupar polígonos visibles por territorio para hacer 1 solo fill() por territorio (máximo rendimiento y color uniforme)
        const buckets = new Map<string, PreparedPolygon[]>();
        const unassignedPolys: PreparedPolygon[] = [];

        for (const poly of this._preparedPolygons) {
            const pMinX = poly.minMx * scaleX + offsetX;
            const pMaxX = poly.maxMx * scaleX + offsetX;
            const pMinY = poly.minMy * scaleY + offsetY;
            const pMaxY = poly.maxMy * scaleY + offsetY;

            // Descartar polígonos fuera del encuadre actual de pantalla
            if (pMaxX < -10 || pMinX > width + 10 || pMaxY < -10 || pMinY > height + 10) {
                continue;
            }

            if (poly.assigned && poly.territoryId) {
                let list = buckets.get(poly.territoryId);
                if (!list) {
                    list = [];
                    buckets.set(poly.territoryId, list);
                }
                list.push(poly);
            } else {
                unassignedPolys.push(poly);
            }
        }

        // 2. Pintar polígonos sin territorio asignado en gris muy suave
        if (unassignedPolys.length > 0) {
            ctx.beginPath();
            for (const poly of unassignedPolys) {
                this.tracePolygonPath(ctx, poly, scaleX, offsetX, scaleY, offsetY);
            }
            ctx.fillStyle = "rgba(148, 163, 184, 0.18)";
            ctx.fill();
        }

        // 3. Pintar cada territorio con su color asignado
        buckets.forEach((polys, territoryId) => {
            const terr = this._territoriesMap.get(territoryId);
            const colorHex = terr ? terr.color : "#2563eb";

            ctx.beginPath();
            for (const poly of polys) {
                this.tracePolygonPath(ctx, poly, scaleX, offsetX, scaleY, offsetY);
            }

            ctx.fillStyle = this.hexToRgba(colorHex, 0.56);
            ctx.fill();

            if (this._showInternalBorders) {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
                ctx.lineWidth = 0.6;
                ctx.stroke();
            } else {
                // Trazo del mismo color para sellar las uniones entre códigos postales colindantes
                ctx.strokeStyle = this.hexToRgba(colorHex, 0.75);
                ctx.lineWidth = 0.7;
                ctx.stroke();
            }
        });

        // 4. Si hay un código postal seleccionado con clic, resaltar su silueta en blanco y negro
        if (this._selectedCpPolygon) {
            ctx.beginPath();
            this.tracePolygonPath(ctx, this._selectedCpPolygon, scaleX, offsetX, scaleY, offsetY);
            ctx.strokeStyle = "#0f172a";
            ctx.lineWidth = 2.2;
            ctx.stroke();
        }

        // 5. Pintar las burbujas / etiquetas con la suma de OTs pendientes en el centroide de cada territorio
        if (this._badgeMode !== "none") {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            this._territoriesMap.forEach((terr) => {
                if (terr.sampleCount <= 0) return;

                const centerLon = terr.sumLon / terr.sampleCount;
                const centerLat = terr.sumLat / terr.sampleCount;
                const cx = this.lonToMercatorX(centerLon) * scaleX + offsetX;
                const cy = this.latToMercatorY(centerLat) * scaleY + offsetY;

                if (cx < -40 || cx > width + 40 || cy < -40 || cy > height + 40) {
                    return;
                }

                if (this._badgeMode === "compact") {
                    const label = `${terr.pendingWOs}`;
                    ctx.font = "700 11px 'Segoe UI', sans-serif";
                    const textW = ctx.measureText(label).width;
                    const pillW = Math.max(28, textW + 14);
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
                    const line1 = terr.name.length > 16 ? terr.name.substring(0, 15) + "…" : terr.name;
                    const line2 = `${terr.pendingWOs} OTs`;
                    ctx.font = "700 11px 'Segoe UI', sans-serif";
                    const w1 = ctx.measureText(line1).width;
                    const w2 = ctx.measureText(line2).width;
                    const pillW = Math.max(w1, w2) + 18;
                    const pillH = 34;

                    this.drawRoundedRect(ctx, cx - pillW / 2, cy - pillH / 2, pillW, pillH, 8);
                    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
                    ctx.fill();
                    ctx.strokeStyle = terr.color;
                    ctx.lineWidth = 2.2;
                    ctx.stroke();

                    ctx.fillStyle = "#ffffff";
                    ctx.fillText(line1, cx, cy - 6);
                    ctx.font = "600 10px 'Segoe UI', sans-serif";
                    ctx.fillStyle = "#93c5fd";
                    ctx.fillText(line2, cx, cy + 8);
                }
            });
        }

        // 6. Actualizar posición en pantalla del popup flotante si está abierto
        if (this._popupPositionLonLat && this._floatingPopupEl.classList.contains("open")) {
            const px = this.lonToMercatorX(this._popupPositionLonLat[0]) * scaleX + offsetX;
            const py = this.latToMercatorY(this._popupPositionLonLat[1]) * scaleY + offsetY;
            this._floatingPopupEl.style.left = `${px}px`;
            this._floatingPopupEl.style.top = `${py}px`;
        }

        ctx.restore();
    }

    private tracePolygonPath(
        ctx: CanvasRenderingContext2D,
        poly: PreparedPolygon,
        scaleX: number,
        offsetX: number,
        scaleY: number,
        offsetY: number
    ): void {
        for (const ring of poly.ringsMercator) {
            if (ring.length < 3) continue;
            ctx.moveTo(ring[0][0] * scaleX + offsetX, ring[0][1] * scaleY + offsetY);
            for (let i = 1; i < ring.length; i++) {
                ctx.lineTo(ring[i][0] * scaleX + offsetX, ring[i][1] * scaleY + offsetY);
            }
            ctx.closePath();
        }
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
                const dMx = this._refMerc2[0] - this._refMerc1[0];
                const dMy = this._refMerc2[1] - this._refMerc1[1];

                if (Math.abs(dMx) > 1e-9 && Math.abs(dMy) > 1e-9) {
                    const scaleX = (p2[0] - p1[0]) / dMx;
                    const scaleY = (p2[1] - p1[1]) / dMy;
                    if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && Math.abs(scaleX) > 1) {
                        return {
                            scaleX,
                            offsetX: p1[0] - this._refMerc1[0] * scaleX,
                            scaleY,
                            offsetY: p1[1] - this._refMerc1[1] * scaleY
                        };
                    }
                }
            }
        } catch {
            // Fallback por cámara si positionsToPixels no está listo en el primer fotograma
        }

        const cam = this._map.getCamera();
        const center = cam.center || [-3.7038, 40.2];
        const zoom = cam.zoom ?? 5.5;
        const worldSize = 512 * Math.pow(2, zoom);
        const centerMx = this.lonToMercatorX(center[0]);
        const centerMy = this.latToMercatorY(center[1]);

        return {
            scaleX: worldSize,
            offsetX: width * 0.5 - centerMx * worldSize,
            scaleY: worldSize,
            offsetY: height * 0.5 - centerMy * worldSize
        };
    }

    /**
     * Busca qué polígono de código postal contiene las coordenadas [lon, lat] donde se hizo clic
     */
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
            this._popupPositionLonLat = null;
            this._floatingPopupEl.classList.remove("open");
            this.drawCanvasOverlay();
            return;
        }

        this._selectedCpPolygon = hitPoly;
        this._popupPositionLonLat = [lon, lat];

        const terr = hitPoly.territoryId ? this._territoriesMap.get(hitPoly.territoryId) : undefined;
        const terrName = terr ? terr.name : "Sin territorio asignado";
        const terrColor = terr ? terr.color : "#94a3b8";
        const pendingWOs = terr ? terr.pendingWOs : 0;
        const totalCps = terr ? terr.postalCodesCount : 0;

        this._floatingPopupEl.innerHTML = `
            <div class="sec-territorios-popup-header">
                <div class="sec-territorios-popup-title">
                    <span class="sec-territorios-color-dot" style="background:${terrColor}"></span>
                    <span>${terrName}</span>
                </div>
                <button type="button" class="sec-territorios-popup-close" title="Cerrar">✕</button>
            </div>
            <div><strong>Código Postal:</strong> ${hitPoly.cpCode || "N/D"}</div>
            <div><strong>OTs pendientes territorio:</strong> ${pendingWOs}</div>
            <div><strong>CPs en el territorio:</strong> ${totalCps.toLocaleString("es-ES")}</div>
        `;

        const closeBtn = this._floatingPopupEl.querySelector(".sec-territorios-popup-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this._selectedCpPolygon = null;
                this._popupPositionLonLat = null;
                this._floatingPopupEl.classList.remove("open");
                this.drawCanvasOverlay();
            });
        }

        this._floatingPopupEl.classList.add("open");
        this.drawCanvasOverlay();
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

        this._territoriesMap.forEach((terr) => {
            const item = document.createElement("div");
            item.className = "sec-territorios-legend-item";
            item.title = "Haz clic para centrar el mapa en este territorio";

            item.innerHTML = `
                <div class="sec-territorios-legend-left">
                    <span class="sec-territorios-color-dot" style="background-color: ${terr.color}"></span>
                    <div>
                        <div class="sec-territorios-legend-name">${terr.name}</div>
                        <div class="sec-territorios-legend-sub">${terr.postalCodesCount.toLocaleString("es-ES")} CPs asignados</div>
                    </div>
                </div>
                <span class="sec-territorios-badge">${terr.pendingWOs} OTs</span>
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

            this._legendListEl.appendChild(item);
        });
    }

    private extractPostalCode(feature: GeoJSON.Feature): string {
        const props = (feature.properties || {}) as Record<string, unknown>;
        let raw: unknown =
            props.COD_POSTAL ??
            props.cod_postal ??
            props.CP ??
            props.cp ??
            props.postalcode ??
            props.codigo_postal ??
            props.msdyn_name ??
            feature.id;

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

    private lonToMercatorX(lon: number): number {
        return (lon + 180) / 360;
    }

    private latToMercatorY(lat: number): number {
        const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
        const sinLat = Math.sin((clamped * Math.PI) / 180);
        return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
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
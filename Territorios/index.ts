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

interface DataverseQueryResult {
    entities: Record<string, unknown>[];
    nextLink?: string;
}

// Paleta de 20 colores diferenciados de alto contraste para distinguir cada territorio
const TERRITORY_PALETTE: string[] = [
    "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
    "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5",
    "#0d9488", "#c026d3", "#ca8a04", "#e11d48", "#0284c7",
    "#15803d", "#9333ea", "#b45309", "#0369a1", "#be123c"
];

export class Territorios implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private static readonly CONTROL_VERSION = "v0.0.5";

    private _context: ComponentFramework.Context<IInputs>;
    private _container: HTMLDivElement;

    // Elementos de interfaz
    private _wrapperEl: HTMLDivElement;
    private _envPillEl: HTMLSpanElement;
    private _statusEl: HTMLSpanElement;
    private _envConfigBarEl: HTMLDivElement;
    private _envUrlInputEl: HTMLInputElement;
    private _envTokenInputEl: HTMLInputElement;
    private _mapContainerEl: HTMLDivElement;
    private _legendListEl: HTMLDivElement;
    private _fileInputEl: HTMLInputElement;
    private _toggleBordersBtn: HTMLButtonElement;

    // Instancias de Azure Maps
    private _map: atlas.Map | null = null;
    private _polygonDataSource: atlas.source.DataSource | null = null;
    private _centroidDataSource: atlas.source.DataSource | null = null;
    private _cpBorderLayer: atlas.layer.LineLayer | null = null;
    private _popup: atlas.Popup | null = null;

    // Estado de configuración y datos en memoria
    private _currentKey = "";
    private _currentTopoUrl = "";
    private _targetEnvUrl = "";
    private _targetAccessToken = "";
    private _manualOverrideEnv = false;
    private _showInternalBorders = false;

    private _baseGeoJson: GeoJSON.FeatureCollection<GeoJSON.Geometry> | null = null;
    private _cpToTerritoryMap: Map<string, string> = new Map<string, string>();
    private _territoriesMap: Map<string, TerritoryInfo> = new Map<string, TerritoryInfo>();

    constructor() {
        // Constructor vacío requerido por PCF
    }

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._context = context;
        this._container = container;

        this.buildUI();
        this.initializeOrUpdate(context);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this._context = context;
        this.initializeOrUpdate(context);
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

        // Selector de archivo oculto para cargar TopoJSON local
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

        // 3. Cuerpo principal: Mapa + Leyenda lateral
        const body = document.createElement("div");
        body.className = "sec-territorios-body";

        this._mapContainerEl = document.createElement("div");
        this._mapContainerEl.className = "sec-territorios-map";

        const sidebar = document.createElement("div");
        sidebar.className = "sec-territorios-sidebar";

        const sidebarHeader = document.createElement("div");
        sidebarHeader.className = "sec-territorios-sidebar-header";
        sidebarHeader.innerHTML = "<span>Territorio</span><span>OTs Pend.</span>";

        this._legendListEl = document.createElement("div");
        this._legendListEl.className = "sec-territorios-legend-list";

        sidebar.appendChild(sidebarHeader);
        sidebar.appendChild(this._legendListEl);

        body.appendChild(this._mapContainerEl);
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

    private initAzureMap(subscriptionKey: string, topoUrl: string): void {
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }

        this.setStatus("Iniciando Azure Maps...");

        this._map = new atlas.Map(this._mapContainerEl, {
            center: [-3.7038, 40.4168], // Centro en España (Madrid)
            zoom: 5.5,
            language: "es-ES",
            view: "Auto",
            style: "grayscale_light",
            authOptions: {
                authType: atlas.AuthenticationType.subscriptionKey,
                subscriptionKey: subscriptionKey
            }
        });

        this._map.events.add("ready", () => {
            if (!this._map) return;

            this._map.controls.add(
                [
                    new atlas.control.ZoomControl(),
                    new atlas.control.StyleControl({
                        mapStyles: ["grayscale_light", "road", "grayscale_dark", "satellite_road_labels"]
                    })
                ],
                { position: atlas.ControlPosition.TopRight }
            );

            this._polygonDataSource = new atlas.source.DataSource();
            this._centroidDataSource = new atlas.source.DataSource();
            this._map.sources.add(this._polygonDataSource);
            this._map.sources.add(this._centroidDataSource);

            this._popup = new atlas.Popup({
                pixelOffset: [0, -10],
                closeButton: true
            });

            // 1. Capa de relleno de polígonos
            const polygonFillLayer = new atlas.layer.PolygonLayer(
                this._polygonDataSource,
                "sec-territories-fill-layer",
                {
                    fillColor: [
                        "case",
                        ["boolean", ["get", "assigned"], false],
                        ["get", "territoryColor"],
                        "#cbd5e1"
                    ],
                    fillOpacity: [
                        "case",
                        ["boolean", ["get", "assigned"], false],
                        0.72,
                        0.25
                    ]
                }
            );

            // 2. Capa de bordes internos de Códigos Postales
            this._cpBorderLayer = new atlas.layer.LineLayer(
                this._polygonDataSource,
                "sec-cp-borders-layer",
                {
                    strokeColor: "#ffffff",
                    strokeWidth: 0.5,
                    strokeOpacity: 0.6,
                    visible: this._showInternalBorders
                }
            );

            // 3. Capa de burbujas en el centroide de cada territorio
            const bubbleLayer = new atlas.layer.BubbleLayer(
                this._centroidDataSource,
                "sec-territory-bubbles",
                {
                    radius: 22,
                    color: "#0f172a",
                    strokeColor: ["get", "territoryColor"],
                    strokeWidth: 3,
                    opacity: 0.92
                }
            );

            // 4. Capa de texto con Nombre del Territorio + Suma de OTs pendientes
            const symbolLayer = new atlas.layer.SymbolLayer(
                this._centroidDataSource,
                "sec-territory-labels",
                {
                    iconOptions: { image: "none" },
                    textOptions: {
                        textField: ["get", "badgeText"],
                        color: "#ffffff",
                        size: 11,
                        offset: [0, 0]
                    }
                }
            );

            this._map.layers.add([polygonFillLayer, this._cpBorderLayer], "labels");
            this._map.layers.add([bubbleLayer, symbolLayer]);

            // Evento click sobre un código postal / territorio
            this._map.events.add("click", polygonFillLayer, (e) => {
                if (e.shapes && e.shapes.length > 0 && this._popup && this._map) {
                    const shape = e.shapes[0] as atlas.Shape;
                    const props = shape.getProperties();
                    const cp = props.cpCode || "Sin CP";
                    const terrName = props.territoryName || "Sin territorio asignado";
                    const terrColor = props.territoryColor || "#94a3b8";
                    const pendingWOs = props.pendingWOs ?? 0;

                    const html = `
                        <div class="sec-territorios-popup">
                            <div class="sec-territorios-popup-title">
                                <span class="sec-territorios-color-dot" style="background:${terrColor}"></span>
                                <span>${terrName}</span>
                            </div>
                            <div><strong>Código Postal:</strong> ${cp}</div>
                            <div><strong>OTs pendientes en el territorio:</strong> ${pendingWOs}</div>
                        </div>
                    `;
                    this._popup.setOptions({
                        content: html,
                        position: e.position
                    });
                    this._popup.open(this._map);
                }
            });

            if (topoUrl) {
                this._currentTopoUrl = topoUrl;
                void this.loadTopoJsonFromUrl(topoUrl);
            } else {
                this.setStatus("Mapa listo. Pulsa '📂 Cargar TopoJSON' o configura 'topoJsonUrl'.");
                void this.refreshDataverseAndRender();
            }
        });
    }

    private toggleInternalBorders(): void {
        this._showInternalBorders = !this._showInternalBorders;
        if (this._cpBorderLayer) {
            this._cpBorderLayer.setOptions({ visible: this._showInternalBorders });
        }
        this._toggleBordersBtn.textContent = this._showInternalBorders
            ? "Bordes CPs: Visibles"
            : "Bordes CPs: Ocultos";
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

            this._baseGeoJson = converted;
            this.setStatus(`TopoJSON convertido: ${this._baseGeoJson.features.length} códigos postales cargados.`);
        } else if (dataObj.type === "FeatureCollection") {
            this._baseGeoJson = rawJson as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
            this.setStatus(`GeoJSON cargado: ${this._baseGeoJson.features.length} códigos postales.`);
        } else {
            throw new Error("Formato no reconocido. Debe ser un TopoJSON o GeoJSON válido.");
        }
    }

    /**
     * Consulta en Dataverse alineada con el FetchXML de msdyn_postalcode:
     * - msdyn_postalcode: msdyn_postalcodeid, msdyn_name, _msdyn_serviceterritory_value (statecode eq 0)
     * - territory: territoryid, name
     * - msdyn_workorder: suma agregada por msdyn_serviceterritory (msdyn_systemstatus = 690970000, statecode = 0)
     */
    private async refreshDataverseAndRender(): Promise<void> {
        const targetLabel = this._targetEnvUrl ? this._targetEnvUrl : "entorno actual";

        try {
            this.setStatus(`Consultando territorios, CPs y OTs en ${targetLabel}...`);

            const territoriesMap = new Map<string, TerritoryInfo>();
            const cpToTerritory = new Map<string, string>();

            // 1. Consultar Territorios (territory)
            const territoryResult = await this.queryDataverse(
                "territory",
                "territories",
                "?$select=territoryid,name&$orderby=name asc"
            );

            territoryResult.entities.forEach((ent, index) => {
                const id = this.cleanGuid(String(ent.territoryid || ""));
                const name = String(ent.name || `Territorio ${index + 1}`);
                const color = TERRITORY_PALETTE[index % TERRITORY_PALETTE.length];

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
            });

            // 2. Consultar Códigos Postales (msdyn_postalcode) con los nombres exactos del FetchXML
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
                        const normalizedCp = rawCp.padStart(5, "0");
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

            if (this._territoriesMap.size === 0 && this._baseGeoJson) {
                this.setStatus(`Sin territorios devueltos en ${targetLabel}. Puedes pulsar '⚡ Simular (Test)'.`);
            } else {
                this.renderCartographyOnMap();
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setStatus(`⚠️ ${msg}`);
        }
    }

    private applyDemoTerritories(): void {
        if (!this._baseGeoJson) {
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

        for (const feat of this._baseGeoJson.features) {
            const cp = this.extractPostalCode(feat);
            if (!cp) continue;
            const prefix = cp.substring(0, 2);
            const matched = demoDefs.find((d) => d.prefixes.includes(prefix));
            if (matched) {
                this._cpToTerritoryMap.set(cp, matched.id);
            }
        }

        this.renderCartographyOnMap();
    }

    private renderCartographyOnMap(): void {
        if (!this._baseGeoJson || !this._polygonDataSource || !this._centroidDataSource) {
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

        for (const feature of this._baseGeoJson.features) {
            const cpCode = this.extractPostalCode(feature);
            const territoryId = cpCode ? this._cpToTerritoryMap.get(cpCode) : undefined;
            const territory = territoryId ? this._territoriesMap.get(territoryId) : undefined;

            if (territory) {
                assignedCount++;
                territory.postalCodesCount++;

                feature.properties = {
                    ...feature.properties,
                    cpCode,
                    assigned: true,
                    territoryId: territory.id,
                    territoryName: territory.name,
                    territoryColor: territory.color,
                    pendingWOs: territory.pendingWOs
                };

                const samplePt = this.getFirstCoordinate(feature.geometry);
                if (samplePt) {
                    const [lon, lat] = samplePt;
                    territory.sumLon += lon;
                    territory.sumLat += lat;
                    territory.sampleCount++;
                    if (lon < territory.minLon) territory.minLon = lon;
                    if (lat < territory.minLat) territory.minLat = lat;
                    if (lon > territory.maxLon) territory.maxLon = lon;
                    if (lat > territory.maxLat) territory.maxLat = lat;
                }
            } else {
                feature.properties = {
                    ...feature.properties,
                    cpCode,
                    assigned: false,
                    territoryName: "No asignado",
                    territoryColor: "#cbd5e1",
                    pendingWOs: 0
                };
            }
        }

        this._polygonDataSource.clear();
        this._polygonDataSource.add(this._baseGeoJson as unknown as atlas.data.FeatureCollection);

        this._centroidDataSource.clear();
        this._territoriesMap.forEach((terr) => {
            if (terr.sampleCount > 0) {
                const centerLon = terr.sumLon / terr.sampleCount;
                const centerLat = terr.sumLat / terr.sampleCount;

                this._centroidDataSource!.add(
                    new atlas.data.Feature(new atlas.data.Point([centerLon, centerLat]), {
                        territoryId: terr.id,
                        territoryName: terr.name,
                        territoryColor: terr.color,
                        pendingWOs: terr.pendingWOs,
                        badgeText: `${terr.name}\n${terr.pendingWOs} OTs`
                    })
                );
            }
        });

        this.renderLegendSidebar();
        this.setStatus(
            `✅ ${this._territoriesMap.size} territorios | ${assignedCount.toLocaleString("es-ES")} CPs pintados`
        );
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
                        bounds: [terr.minLon - 0.3, terr.minLat - 0.3, terr.maxLon + 0.3, terr.maxLat + 0.3],
                        padding: 40,
                        type: "ease",
                        duration: 800
                    });
                }
            });

            this._legendListEl.appendChild(item);
        });
    }

    private extractPostalCode(feature: GeoJSON.Feature): string {
        const props = (feature.properties || {}) as Record<string, unknown>;
        const raw =
            props.COD_POSTAL ??
            props.cod_postal ??
            props.CP ??
            props.cp ??
            props.postalcode ??
            props.codigo_postal ??
            feature.id ??
            "";
        const str = String(raw).trim();
        return str ? str.padStart(5, "0") : "";
    }

    private getFirstCoordinate(geometry: GeoJSON.Geometry | null): [number, number] | null {
        if (!geometry) return null;
        if (geometry.type === "Polygon" && geometry.coordinates[0]?.[0]) {
            return [geometry.coordinates[0][0][0], geometry.coordinates[0][0][1]];
        }
        if (geometry.type === "MultiPolygon" && geometry.coordinates[0]?.[0]?.[0]) {
            return [geometry.coordinates[0][0][0][0], geometry.coordinates[0][0][0][1]];
        }
        return null;
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
        if (this._map) {
            this._map.dispose();
            this._map = null;
        }
    }
}
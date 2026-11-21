# KOI Pokémon VGC Results

Panel web que sigue cruces de Pokémon VGC en PokéData y muestra las novedades en OBS. El streamer necesita un navegador y OBS Studio. El servidor hace las consultas y conserva el estado aunque se cierre el panel.

Herramienta interna e independiente. El nombre y la identidad visual se usan para identificar el equipo. Los recursos de terceros conservan sus derechos.

## Probar desde Windows

En el ordenador de desarrollo, con Node.js 24 o posterior:

```powershell
npm.cmd ci
npm.cmd run dev
```

Abre [el panel local](http://127.0.0.1:38470) e introduce el código configurado en `ACCESS_CODES` o el código temporal que muestra la terminal si arrancas sin ese ajuste.

Para editar los ajustes de arranque, copia [`.env.example`](.env.example) a `.env`. Guarda el código fijo en ese archivo local o en los secretos del proveedor.

1. En **Dashboard → Configuración**, pega el [enlace de un torneo](https://www.pokedata.ovh/standings2/1000088), elige la división, pulsa **Cargar jugadores** y guarda hasta dos participantes. Arranca el seguimiento desde **Dashboard → Seguimiento**.
2. Copia la **URL de directo** desde **Dashboard → Configuración** y pégala en **OBS → Fuentes → Navegador**. Introduce **1920 × 1080** o **1280 × 720** según el lienzo. El overlay es transparente y queda vacío hasta que guardas jugadores.
3. En **Dashboard → Pruebas**, abre la fuente de prueba o añade su URL a OBS. Elige un aviso, una transición del marcador, un menú o la conexión de OBS. Usa **Probar** y **Parar prueba**, o abre o copia el enlace de una prueba concreta para que se ejecute al cargar la fuente.
4. El Dashboard muestra la fuente de directo y permite escuchar localmente los sonidos de los menús que abres o cierras desde el panel. Usa **Probar aviso**, **Probar equipo** y **Probar historial** para comprobar el widget. Al terminar el directo, pulsa **Pausar seguimiento**. Las sesiones activas caducan a las 12 horas.

## Configurar el overlay

- **Diseño → General** controla los alias, las posiciones base y los desplazamientos del marcador y los avisos. También puedes ajustar los márgenes del lienzo, la opacidad de cada elemento y el color de acento. El mapa refleja estos ajustes al editar.
- **Diseño → Marcador** reúne estilo, tamaño, campos visibles y orden de jugadores. Configura también la entrada, la salida y los efectos que se aplican al mostrar u ocultar el marcador.
- **Diseño → Avisos** permite elegir qué tipos se muestran en directo, seleccionar **GIF y datos** o **Solo datos**, y ajustar el formato, los datos visibles y los tiempos de animación. **Dashboard → Pruebas** permite ensayar cualquier tipo.
- **Aplicar al overlay** guarda todas las pestañas de Diseño y actualiza las fuentes abiertas durante el seguimiento. Desde **Seguimiento** también puedes mostrar u ocultar el marcador. Para cambiar el torneo, la división o los jugadores, pausa el seguimiento.
- **Dashboard → Pruebas** envía el escenario elegido a la URL de ensayo aunque los avisos estén desactivados para el directo. Para comprobar el encuadre, usa una fuente con el mismo ancho y alto que el lienzo de OBS.

## Catálogo de imágenes y sonidos

Los archivos del catálogo se gestionan en el ordenador que ejecuta el servidor. Copia un archivo en la carpeta adecuada y pulsa **Actualizar catálogo** en **Sprites** o **Sonidos**.

| Carpeta | Contenido |
| --- | --- |
| `media/players` | Imágenes de jugadores. Incluye los iconos de Riopaser y Pokealex. |
| `media/pokemon` | Imágenes y vídeos WebM para los seis espacios de cada jugador. Los vídeos se reproducen en bucle y sin audio. |
| `media/gifs` | GIFs para acompañar los avisos. En **Sprites → GIFs de avisos**, marca uno o varios por tipo y pulsa **Guardar GIFs**. |
| `media/sounds` | Audios MP3, OGG o WAV que acompañan a los avisos. |

Para imágenes se admiten PNG, GIF, WebP y JPG. Límite de 16 MB por archivo. Los sprites asignados con la versión anterior siguen disponibles en sus espacios actuales. En un despliegue, puedes conectar una carpeta de catálogo adicional mediante `MEDIA_DIR`, con las mismas cuatro subcarpetas.

El catálogo incluye modelos animados de Pokémon HOME obtenidos de WikiDex. La [utilidad de descarga](herramientas/descargar-sprites-home/README.md) documenta su origen y cómo actualizar la colección. Revisa las autorizaciones de los logos, fotos, GIFs, sprites y sonidos antes de publicar los archivos multimedia fuera del ámbito interno.

En **Sprites → GIFs de avisos**, cada tipo tiene su propia pestaña y selección. Pulsa el nombre para ver el archivo o elige **En la notificación** para probarlo con el diseño que estés editando. Marca las casillas y pulsa **Guardar GIFs** para incluir esos archivos en la rotación de ese tipo. Cuando hay varios, el overlay evita repetir el anterior del mismo tipo mientras la fuente sigue abierta.

En **Sprites → Equipos Pokémon** puedes previsualizar el equipo completo o el marcador con el primer Pokémon del jugador. En **Seguimiento → Equipo e historial en directo** abres y cierras esos menús en la fuente de directo desde el panel. En la vista de ensayo, la Poké Ball abre el equipo y la Pokédex abre las rondas publicadas en PokéData.

En **Sonidos → Avisos**, marca los tonos o archivos que quieras para cada tipo de aviso y guarda la selección de esa pestaña. El overlay elige uno al azar y evita repetir el último si hay alternativas. Pulsa el nombre de un sonido para escucharlo o probarlo en una notificación. En **Sonidos → Marcador** puedes añadir sonidos al abrir o cerrar el equipo y el historial. Los menús empiezan en silencio. En **Sonidos → General**, regula el volumen general y el nivel de avisos y menús por separado. Para probar la mezcla en OBS, envía un aviso desde **Dashboard → Pruebas**.

## Servir por HTTPS

El panel, la API y el overlay se sirven desde el mismo origen HTTPS. El [Dockerfile](Dockerfile) incluye el servidor Node.js y los archivos web. El proveedor debe mantener el proceso activo, montar un disco persistente para SQLite y permitir conexiones SSE sin búfer. Usa `/healthz` para los chequeos del servicio y excluye las rutas de overlay de los registros que puedan exponer los enlaces privados.

En **Dashboard → Configuración → URL base del proyecto**, pulsa el ojo para editar la dirección que usarán los enlaces de directo y pruebas. Guarda un origen que ya sirva esta instancia, como `https://vgc.example.org`. El valor se guarda por cuenta en SQLite y se puede volver a cambiar desde el panel. **Usar URL del servidor** recupera `PUBLIC_ORIGIN`, que sigue siendo el origen de acceso al panel configurado en el despliegue.

GitHub Pages publica el login y el Dashboard compilados desde los mismos archivos que sirve la instancia Node.js. Desde Pages, el navegador consulta la API de Clouding. Clouding valida el código, guarda la configuración en SQLite, consulta PokéData y mantiene las fuentes HTTPS de OBS. [Documentación de GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Para activar este modo, actualiza primero Clouding y añade `PAGES_ORIGIN=https://fibanezv.github.io` al `.env` del servidor. Reinicia la app con PM2. En GitHub, cambia la fuente de **Settings → Pages** a **GitHub Actions** y ejecuta **Publicar el panel en GitHub Pages**. La compilación usa por defecto el origen HTTPS de Clouding. Puedes cambiarlo con la variable del repositorio `PAGES_BACKEND_ORIGIN`. Conserva `ACCESS_CODES` en el servidor. [Publicar con GitHub Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

| Variable | Configuración |
| --- | --- |
| `PUBLIC_ORIGIN` | Origen HTTPS canónico, sin ruta. Ejemplo `https://vgc.example.org`. |
| `PAGES_ORIGIN` | Origen de Pages autorizado para usar la API desde el navegador. Es opcional y se indica sin la ruta del repositorio. |
| `ACCESS_CODES` | Objeto JSON privado con una clave de operador por invitación y un código aleatorio distinto por operador. Cada código tiene al menos 32 caracteres URL-safe. |
| `DATA_DIR` | Carpeta con escritura para el usuario del proceso. Monta un volumen persistente en `/data` para el contenedor y respáldalo según el proveedor. |
| `PORT` y `HOST` | Puerto y dirección de escucha. El contenedor usa `8080` y `0.0.0.0` por defecto. En desarrollo se usa la interfaz de loopback. |

Los códigos se generan con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` y se entregan por un canal privado. El acceso directo a Clouding usa una cookie de sesión. En Pages, el servidor devuelve una credencial de sesión que el navegador guarda durante la pestaña y elimina al cerrar sesión. Cambiar el código de un operador e iniciar el servicio con la configuración nueva invalida sus sesiones anteriores. Los overlays usan enlaces revocables de solo lectura.

## Primer push a GitHub

Para el catálogo interno actual, crea un repositorio **privado** llamado `koi-vgc-results` en la cuenta u organización que vaya a mantenerlo. Créalo vacío, ya que este proyecto aporta su README, su `.gitignore` y el historial local.

Desde la raíz del proyecto, conecta el repositorio vacío y sube `main`. Cambia `CUENTA` por el propietario real.

```powershell
git remote add origin https://github.com/CUENTA/koi-vgc-results.git
git push -u origin main
```

GitHub Actions ejecutará la instalación desde el lockfile, la compilación y las pruebas en Linux y Windows. El push guarda el código y el catálogo. El despliegue HTTPS se realiza en la instancia Node.js. [Guía de GitHub para subir código local](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

### Comprobaciones antes del despliegue

1. Mantén `.env`, `data/` y los enlaces privados fuera del repositorio. Revisa los permisos de los archivos multimedia antes de hacerlos accesibles en una web pública.
2. Despliega el contenedor detrás de un proxy HTTPS de confianza y configura los secretos y el volumen de datos. Las selecciones de una instancia local viven en su SQLite. Si quieres llevarlas al servidor, copia esa base de datos mediante un respaldo consistente y configura el mismo catálogo de archivos.
3. Desde otro equipo, prueba el acceso, el seguimiento y ambas fuentes de navegador en OBS. Reinicia la instancia para comprobar la persistencia. Configura respaldos y comprueba que los logs del proxy omiten los tokens de `/o/`.

## Desarrollo y verificación

- `npm run build` comprueba TypeScript y genera servidor y vistas.
- `npm test` prueba el adaptador y un recorrido HTTP/SSE con datos simulados. Necesita acceso a una conexión local de loopback.
- El JSON de PokéData aporta el resultado del cruce, mesa y balance. La cadencia de consulta es de un minuto, compartida entre operadores que siguen el mismo torneo y división. La demora de publicación de PokéData se suma a ese intervalo.
- El JSON validado para el piloto publica el resultado del cruce. El desglose de partidas, como `2–1`, no está disponible en ese formato.

[Roadmap web](ROADMAP.md) · [Fuente de navegador de OBS](https://obsproject.com/kb/browser-source)

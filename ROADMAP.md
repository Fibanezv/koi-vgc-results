# KOI Pokémon VGC Results · Roadmap web

## Estado del piloto

La aplicación web funciona localmente. Incluye un panel privado con códigos de invitación y fuentes separadas para directo y pruebas. El Dashboard reúne Seguimiento, Configuración y Pruebas. El marcador ofrece los estilos KOI y 8 bits, y los avisos admiten formato horizontal, tarjeta o panorámico, con animaciones, GIFs y sonidos configurables. El operador puede abrir el equipo y el historial de cada jugador desde el Dashboard.

El servicio usa Node.js, TypeScript, Express y SQLite. Sirve el panel, la API y el overlay en el mismo origen. Las fuentes de OBS reciben cambios por SSE y se abren con enlaces revocables. El servidor consulta PokéData cada minuto por torneo y división con seguimiento activo y conserva las configuraciones en SQLite. Un seguimiento caduca a las 12 horas.

En la validación local se cargó el LAIC Masters (`1000088`) y se mostraron los cruces pendientes de dos jugadores reales. OBS Studio mostró una victoria y una corrección simuladas a 1920 × 1080. El JSON validado aporta mesa, rival, resultado y balance del cruce. El formato inspeccionado carece del desglose de partidas, como `2–1`.

## Próximos pasos

| Paso | Entregable | Verificación |
| --- | --- | --- |
| Repositorio | Subir `main` a un repositorio privado y activar las comprobaciones de GitHub Actions. | Un clon nuevo instala dependencias, compila y supera las pruebas. El repositorio excluye secretos y datos de directo. |
| Piloto HTTPS | Elegir cuenta de alojamiento, dominio y almacenamiento persistente para SQLite. Configurar los códigos en el proveedor y servir panel y overlay desde el mismo origen. | En otra red, un operador entra con su invitación y OBS abre las fuentes de directo y pruebas. Tras reiniciar se recupera la configuración y un enlace revocado pierde acceso. |
| Torneo activo | Observar una transición de pendiente a resultado publicado. Medir por separado el retraso de PokéData, el intervalo de consulta y el tiempo hasta la animación en OBS. | Se emite un aviso para el jugador seguido, el otro conserva su estado y los cruces de terceros no cambian el marcador. |
| Ensayo de retransmisión | Probar con OBS a 1080p y 720p, con fondo de contraste, entrada y salida, marcador, historial, equipo, alertas y audio. | Un streamer configura una escena siguiendo la [guía](README.md), ejecuta y para una prueba e inicia y pausa el seguimiento. |
| Operación | Configurar copias consistentes de SQLite, comprobar la recuperación y excluir los tokens del overlay de los logs del proxy. | El operador puede recuperar una configuración y regenerar un enlace sin exponer credenciales. |

## Opciones para una siguiente iteración

- Reemisión de un resultado desde el historial o avisos manuales al aire con confirmación explícita y registro de cada envío.
- Estado de las fuentes y diagnóstico de reconexión para distinguir una fuente conectada de una escena visible.
- Inicio de sesión mediante un proveedor de identidad si el piloto se amplía.

[PokéData · LAIC Masters](https://www.pokedata.ovh/standings2/1000088/Masters) · [OBS Studio · Fuente de navegador](https://obsproject.com/kb/browser-source)

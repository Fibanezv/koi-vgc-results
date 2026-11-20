# Descarga de sprites animados de Pokémon HOME

Utilidad de línea de comandos para KOI Pokémon VGC Results. Funciona en Windows con Node.js 24, sin instalar dependencias ni arrancar la app.

Abre PowerShell en esta carpeta y ejecuta:

```powershell
node .\descargar.mjs
```

Por defecto solo procesa el primer nombre de `pokemon.txt`, Garchomp. Usa `--pokemon "Primarina"` para descargar solo ese Pokémon, `--limit 5` para los primeros cinco nombres distintos o `--all` para toda la lista. Los WebM se guardan en `media/pokemon`, junto a Garchomp, y se conservan los archivos existentes. En el panel, ve a **Sprites → Equipos Pokémon** y pulsa **Actualizar catálogo** para verlos en los selectores.

El script abre la búsqueda de WikiDex, sigue la ficha y localiza sus vídeos de Pokémon HOME en las secciones de sprites o modelos. Descarga el sprite normal con VP9 a 240p cuando existe esa resolución. Si WikiDex solo ofrece el WebM original, usa ese. Si el nombre de una forma no coincide de manera inequívoca, lo indica en la consola.

La lista conserva el orden de OP.GG y distingue las formas de Hisui que allí comparten nombre con su forma base, identificadas por los tipos que muestra la tabla. Los cuatro tamaños de Gourgeist comparten el único vídeo HOME de su ficha en WikiDex. Puedes repetir `--pokemon` para seleccionar varios nombres o editar `pokemon.txt`.

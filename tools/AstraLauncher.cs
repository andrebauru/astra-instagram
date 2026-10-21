using System;
using System.Diagnostics;
using System.IO;

internal static class AstraLauncher
{
    private static int Main(string[] argumentos)
    {
        string pasta = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(pasta, "runtime", "node.exe");
        if (!File.Exists(node))
        {
            Console.Error.WriteLine("Runtime do Astra não encontrado. Extraia novamente o pacote completo.");
            return 1;
        }

        bool mostrarVersao = argumentos.Length == 1 && argumentos[0] == "--version";
        var inicio = new ProcessStartInfo
        {
            FileName = node,
            Arguments = mostrarVersao ? "--version" : "iniciar.js",
            WorkingDirectory = pasta,
            UseShellExecute = false,
            CreateNoWindow = false
        };

        try
        {
            using (Process processo = Process.Start(inicio))
            {
                processo.WaitForExit();
                return processo.ExitCode;
            }
        }
        catch (Exception)
        {
            Console.Error.WriteLine("Não foi possível iniciar o Astra. Confira se o pacote foi extraído por completo.");
            return 1;
        }
    }
}
